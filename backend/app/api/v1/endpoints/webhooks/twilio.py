"""
Twilio Webhooks - SMS and WhatsApp incoming and status updates
"""
import asyncio
import logging
from typing import Optional, List, Tuple
from uuid import UUID
import httpx
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import PlainTextResponse
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.database import get_db, async_session_maker
from app.services.sms_conversation_service import get_sms_conversation_service
from app.services.whatsapp_conversation_service import get_whatsapp_conversation_service
from app.services.dealership_twilio_config_service import (
    find_dealership_id_by_inbound_to,
    get_effective_twilio_config,
)
from app.services.notification_service import NotificationService
from app.core.websocket_manager import ws_manager
from app.core.config import settings
from app.models.lead import Lead
from app.models.notification import NotificationType

logger = logging.getLogger(__name__)

# Delay before sending WhatsApp email notifications (3 minutes)
WHATSAPP_EMAIL_DELAY_SECONDS = 180


async def send_delayed_whatsapp_email(
    message_id: UUID,
    user_id: UUID,
    title: str,
    message: str,
    link: str,
    notification_type_value: str,
    meta_data: dict
):
    """
    Background task to send WhatsApp email notification after a delay.
    Only sends if the message is still unread after the delay.
    """
    try:
        # Wait for the delay period
        await asyncio.sleep(WHATSAPP_EMAIL_DELAY_SECONDS)
        
        # Check if message is still unread using a fresh database session
        async with async_session_maker() as db:
            from app.models.whatsapp_log import WhatsAppLog
            result = await db.execute(
                select(WhatsAppLog.is_read).where(WhatsAppLog.id == message_id)
            )
            is_read = result.scalar_one_or_none()
            
            # Only send email if message is still unread
            if is_read is False:
                from app.models.notification import NotificationType
                notification_service = NotificationService(db)
                
                # Create a notification with email only (push already sent)
                await notification_service.create_notification(
                    user_id=user_id,
                    title=title,
                    message=message,
                    link=link,
                    notification_type=NotificationType(notification_type_value),
                    meta_data={**meta_data, "delayed_email": True},
                    send_push=False,  # Push already sent immediately
                    send_email=True,
                    send_sms=False
                )
                await db.commit()
                logger.info(f"Sent delayed WhatsApp email for message {message_id} to user {user_id}")
            else:
                logger.debug(f"Skipping delayed email for message {message_id} - already read")
    except Exception as e:
        logger.warning(f"Failed to send delayed WhatsApp email for message {message_id}: {e}")

router = APIRouter()


@router.get("/debug/ping")
async def webhook_debug_ping():
    """Simple ping endpoint to verify webhook routing works."""
    return {"status": "ok", "message": "Twilio webhook router is accessible"}


@router.post("/debug/echo", response_class=PlainTextResponse)
async def webhook_debug_echo(request: Request):
    """Echo incoming webhook data for debugging."""
    form_data = await request.form()
    data = dict(form_data)
    logger.info(f"DEBUG WEBHOOK ECHO: {data}")
    return f"Received: {data}"


async def transfer_twilio_media_to_azure(
    twilio_urls: List[str],
    content_types: List[str],
    dealership_id: Optional[UUID] = None,
) -> Tuple[List[str], List[str]]:
    """
    Download media from Twilio URLs and upload to Azure Blob storage.
    Returns tuple of (azure_urls, content_types).
    """
    from app.services.azure_storage_service import azure_storage_service
    
    if not azure_storage_service.is_whatsapp_media_configured:
        logger.warning("Azure WhatsApp media storage not configured, keeping Twilio URLs")
        return twilio_urls, content_types
    
    azure_urls = []
    final_content_types = []
    
    # Get Twilio credentials for authenticated media fetch
    account_sid = settings.twilio_account_sid
    auth_token = settings.twilio_auth_token
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        for i, twilio_url in enumerate(twilio_urls):
            content_type = content_types[i] if i < len(content_types) else "application/octet-stream"
            
            try:
                # Twilio media URLs require authentication
                response = await client.get(
                    twilio_url,
                    auth=(account_sid, auth_token) if account_sid and auth_token else None,
                    follow_redirects=True,
                )
                
                if response.status_code != 200:
                    logger.error(f"Failed to download Twilio media: {response.status_code}")
                    azure_urls.append(twilio_url)  # Keep original URL as fallback
                    final_content_types.append(content_type)
                    continue
                
                media_data = response.content
                
                # Determine filename from content type
                ext_map = {
                    "image/jpeg": "jpg",
                    "image/png": "png",
                    "image/gif": "gif",
                    "image/webp": "webp",
                    "video/mp4": "mp4",
                    "video/3gpp": "3gp",
                    "audio/ogg": "ogg",
                    "audio/mpeg": "mp3",
                    "audio/amr": "amr",
                    "audio/aac": "aac",
                    "application/pdf": "pdf",
                }
                ext = ext_map.get(content_type, content_type.split("/")[-1] if "/" in content_type else "bin")
                filename = f"incoming_media.{ext}"
                
                # Upload to Azure
                azure_url = await azure_storage_service.upload_whatsapp_media(
                    data=media_data,
                    filename=filename,
                    content_type=content_type,
                    dealership_id=dealership_id,
                )
                
                if azure_url:
                    azure_urls.append(azure_url)
                    final_content_types.append(content_type)
                    logger.info(f"Transferred Twilio media to Azure: {azure_url}")
                else:
                    logger.error("Azure upload returned None, keeping Twilio URL")
                    azure_urls.append(twilio_url)
                    final_content_types.append(content_type)
                    
            except Exception as e:
                logger.error(f"Error transferring media from Twilio to Azure: {e}")
                azure_urls.append(twilio_url)  # Keep original URL as fallback
                final_content_types.append(content_type)
    
    return azure_urls, final_content_types


def _normalize_whatsapp_number(raw: str) -> str:
    """Strip whatsapp: prefix for storage/lookup."""
    if raw.startswith("whatsapp:"):
        return raw[9:].strip()
    return raw.strip()


async def _is_valid_twilio_request(request: Request, form_data, db: AsyncSession) -> bool:
    """Check X-Twilio-Signature against every auth token and public URL we might be reached at."""
    if not settings.twilio_validate_webhooks:
        return True
    signature = request.headers.get("X-Twilio-Signature", "")
    if not signature:
        return False
    from twilio.request_validator import RequestValidator

    tokens = {settings.twilio_auth_token}
    to_number = form_data.get("To", "")
    dealership_id = await find_dealership_id_by_inbound_to(db, to_number) if to_number else None
    if dealership_id:
        tokens.add((await get_effective_twilio_config(db, dealership_id)).auth_token)
    path_qs = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    urls = {
        f"{settings.backend_url.rstrip('/')}{path_qs}",
        str(request.url),
        str(request.url).replace("http://", "https://", 1),
    }
    params = {k: v for k, v in form_data.multi_items()}
    for token in filter(None, tokens):
        validator = RequestValidator(token)
        if any(validator.validate(url, params, signature) for url in urls):
            return True
    logger.warning("Rejected Twilio webhook with invalid signature: %s", request.url.path)
    return False


_EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'


@router.post("/sms/incoming", response_class=PlainTextResponse)
async def handle_incoming_sms(
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    Twilio webhook for incoming SMS messages.
    Stores the message, applies STOP/START/HELP consent changes and notifies the agent.
    """
    form_data = await request.form()
    if not await _is_valid_twilio_request(request, form_data, db):
        return Response(status_code=403)
    
    message_sid = form_data.get("MessageSid", "")
    from_number = form_data.get("From", "")
    to_number = form_data.get("To", "")
    body = form_data.get("Body", "")
    opt_out_type = form_data.get("OptOutType") or None
    num_media = int(form_data.get("NumMedia", "0"))
    
    # Extract media URLs and content types
    twilio_media_urls = []
    twilio_content_types = []
    for i in range(num_media):
        media_url = form_data.get(f"MediaUrl{i}")
        content_type = form_data.get(f"MediaContentType{i}") or "application/octet-stream"
        if media_url:
            twilio_media_urls.append(media_url)
            twilio_content_types.append(content_type)
    
    logger.info(f"Incoming SMS webhook: {message_sid} from {from_number}")

    resolved_dealership_id = await find_dealership_id_by_inbound_to(db, to_number)

    # Twilio retries webhooks; store each message once.
    from app.models.sms_log import SMSLog
    already = await db.execute(select(SMSLog.id).where(SMSLog.twilio_message_sid == message_sid))
    if message_sid and already.scalar_one_or_none():
        return Response(content=_EMPTY_TWIML, media_type="application/xml")

    # Transfer media from Twilio to Azure Blob storage
    media_urls = twilio_media_urls
    if twilio_media_urls:
        try:
            media_urls, _ = await transfer_twilio_media_to_azure(
                twilio_media_urls,
                twilio_content_types,
                dealership_id=resolved_dealership_id,
            )
            logger.info(f"SMS: Transferred {len(media_urls)} media files to Azure")
        except Exception as e:
            logger.error(f"SMS: Failed to transfer media to Azure, using Twilio URLs: {e}")
            media_urls = twilio_media_urls

    service = get_sms_conversation_service(db)

    sms_log, keyword, compliance_reply = await service.receive_sms(
        message_sid=message_sid,
        from_number=from_number,
        to_number=to_number,
        body=body,
        media_urls=media_urls,
        media_content_types=twilio_content_types,
        resolved_dealership_id=resolved_dealership_id,
        opt_out_type=opt_out_type,
    )
    
    await db.commit()

    if compliance_reply:
        from app.services.sms_consent_service import CATEGORY_COMPLIANCE
        await service.send_sms(
            to_number=from_number,
            body=compliance_reply,
            user_id=None,
            lead_id=sms_log.lead_id,
            dealership_id=sms_log.dealership_id or resolved_dealership_id,
            category=CATEGORY_COMPLIANCE,
        )
        await db.commit()
    
    if sms_log.lead_id:
        await ws_manager.broadcast_to_dealership(
            str(sms_log.dealership_id) if sms_log.dealership_id else None,
            {
                "type": "sms:received",
                "payload": {
                    "message_id": str(sms_log.id),
                    "lead_id": str(sms_log.lead_id),
                    "from_number": from_number,
                    "body_preview": body[:100] if body else "",
                    "has_media": len(media_urls) > 0,
                    "keyword": keyword,
                }
            }
        )

    # Notify the agent working the lead (or active team members when unassigned)
    if sms_log.lead_id:
        notification_service = NotificationService(db)

        result = await db.execute(
            select(Lead).options(selectinload(Lead.customer)).where(Lead.id == sms_log.lead_id)
        )
        lead = result.scalar_one_or_none()
        lead_name = f"{lead.first_name} {lead.last_name or ''}".strip() if lead else "Unknown"

        if keyword == "opt_out":
            title, text = "Customer opted out of texts", f"{lead_name} replied {body.strip()}. Texts to them are now blocked."
        elif keyword == "opt_in":
            title, text = "Customer opted back in to texts", f"{lead_name} replied {body.strip()} and can be texted again."
        else:
            title = "New SMS Received"
            preview = (body or "").strip() or ("[Attachment]" if media_urls else "")
            text = f"Message from {lead_name}: {preview[:50]}..." if len(preview) > 50 else f"Message from {lead_name}: {preview}"

        # If any agent is actively viewing this chat right now, mark it read immediately
        if ws_manager.anyone_viewing_sms_lead(str(sms_log.lead_id)):
            sms_log.is_read = True
            from app.core.timezone import utc_now
            sms_log.read_at = utc_now()

        if sms_log.user_id:
            recipient_ids = [sms_log.user_id]
        else:
            from app.models.user import User
            from app.core.permissions import UserRole
            users_res = await db.execute(
                select(User.id).where(
                    User.dealership_id == sms_log.dealership_id,
                    User.is_active.is_(True),
                    User.role.in_([UserRole.BDC, UserRole.DEALERSHIP_ADMIN, UserRole.SUPER_ADMIN]),
                )
            )
            recipient_ids = list(users_res.scalars().all())

        notified_any = False
        for uid in recipient_ids:
            # Skip bell/push/email notification for users who currently have this chat open
            if ws_manager.is_viewing_sms_lead(str(uid), str(sms_log.lead_id)):
                continue
            await notification_service.create_notification(
                user_id=uid,
                title=title,
                message=text,
                link=f"/sms?lead={sms_log.lead_id}",
                notification_type=NotificationType.SMS_RECEIVED,
                meta_data={
                    "lead_id": str(sms_log.lead_id),
                    "message_id": str(sms_log.id),
                    "from_number": from_number,
                },
                send_push=True,
                send_email=True,   # Chat isn't open — also notify via email
                send_sms=False,    # Don't SMS about SMS
            )
            notified_any = True

        if notified_any or sms_log.is_read:
            await db.commit()

        from app.services.sms_unread_realtime import push_sms_unread_for_dealership

        await push_sms_unread_for_dealership(
            db, str(sms_log.dealership_id) if sms_log.dealership_id else None
        )
    
    # Empty TwiML: Twilio answers English keywords itself, the CRM sends everything else via the API
    return Response(content=_EMPTY_TWIML, media_type="application/xml")


@router.post("/sms/status")
async def handle_sms_status(
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    Twilio webhook for SMS delivery status updates.
    Updates the message status in the database.
    """
    form_data = await request.form()
    if not await _is_valid_twilio_request(request, form_data, db):
        return Response(status_code=403)
    
    message_sid = form_data.get("MessageSid", "")
    message_status = form_data.get("MessageStatus", "")
    error_code = form_data.get("ErrorCode")
    error_message = form_data.get("ErrorMessage")
    
    logger.info(f"SMS status webhook: {message_sid} -> {message_status}")
    
    service = get_sms_conversation_service(db)
    
    sms_log = await service.update_delivery_status(
        message_sid=message_sid,
        status=message_status,
        error_code=error_code,
        error_message=error_message
    )
    
    if sms_log:
        # Send real-time status update
        if sms_log.lead_id:
            await ws_manager.broadcast_to_dealership(
                str(sms_log.dealership_id) if sms_log.dealership_id else None,
                {
                    "type": "sms:status",
                    "payload": {
                        "message_id": str(sms_log.id),
                        "lead_id": str(sms_log.lead_id),
                        "status": message_status
                    }
                }
            )
    
    await db.commit()
    
    return {"status": "ok"}


@router.post("/whatsapp/incoming", response_class=PlainTextResponse)
async def handle_incoming_whatsapp(
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """Twilio webhook for incoming WhatsApp messages."""
    form_data = await request.form()
    # MessageSid is standard; SmsSid appears on some Twilio channels / retries.
    message_sid = (form_data.get("MessageSid") or form_data.get("SmsSid") or "").strip()
    from_raw = form_data.get("From") or ""
    to_raw = form_data.get("To") or ""
    body = str(form_data.get("Body") or "")
    raw_num_media = form_data.get("NumMedia")
    try:
        num_media = int(raw_num_media) if raw_num_media not in (None, "") else 0
    except (TypeError, ValueError):
        num_media = 0
    from_number = _normalize_whatsapp_number(from_raw) or (str(from_raw).replace("whatsapp:", "")[:32])
    to_number = _normalize_whatsapp_number(to_raw) or (str(to_raw).replace("whatsapp:", "")[:32])

    twilio_media_urls = []
    twilio_content_types = []
    for i in range(max(0, num_media)):
        url = form_data.get(f"MediaUrl{i}")
        content_type = form_data.get(f"MediaContentType{i}") or ""
        if url:
            twilio_media_urls.append(url)
            twilio_content_types.append(content_type)

    logger.info(
        "Incoming WhatsApp webhook: sid=%s from=%s to=%s body_len=%s media_count=%s",
        message_sid or "(empty)",
        from_number,
        to_number,
        len(body),
        len(twilio_media_urls),
    )
    resolved_dealership_id = await find_dealership_id_by_inbound_to(db, to_raw)
    
    # If no dealership found, try to get first dealership as fallback
    if not resolved_dealership_id:
        logger.warning(f"No dealership found for To number: {to_raw}. Trying fallback.")
        from app.models.dealership import Dealership
        fallback_result = await db.execute(
            select(Dealership).order_by(Dealership.created_at.asc()).limit(1)
        )
        fallback_dealership = fallback_result.scalar_one_or_none()
        if fallback_dealership:
            resolved_dealership_id = fallback_dealership.id
            logger.info(f"Using fallback dealership: {resolved_dealership_id}")
        else:
            logger.error("No dealerships found in database! Unknown messages won't be visible.")
    
    logger.info(f"Resolved dealership_id for incoming WhatsApp: {resolved_dealership_id}")

    # Transfer media from Twilio to Azure Blob storage
    media_urls = twilio_media_urls
    media_content_types = twilio_content_types
    if twilio_media_urls:
        try:
            media_urls, media_content_types = await transfer_twilio_media_to_azure(
                twilio_media_urls,
                twilio_content_types,
                dealership_id=resolved_dealership_id,
            )
            logger.info(f"Transferred {len(media_urls)} media files to Azure")
        except Exception as e:
            logger.error(f"Failed to transfer media to Azure, using Twilio URLs: {e}")
            media_urls = twilio_media_urls
            media_content_types = twilio_content_types

    try:
        service = get_whatsapp_conversation_service(db)
        wa_log, is_new_lead, new_lead = await service.receive_whatsapp(
            message_sid=message_sid,
            from_number=from_number,
            to_number=to_number,
            body=body,
            media_urls=media_urls,
            media_content_types=media_content_types,
            resolved_dealership_id=resolved_dealership_id,
        )
        await db.commit()
        logger.info(
            "Incoming WhatsApp stored: id=%s direction=inbound sid=%s lead_id=%s is_new_lead=%s",
            wa_log.id, wa_log.twilio_message_sid, wa_log.lead_id, is_new_lead
        )
    except Exception as e:
        logger.error(
            "CRITICAL: Failed to process incoming WhatsApp from=%s to=%s sid=%s error=%s",
            from_number, to_number, message_sid, str(e),
            exc_info=True
        )
        # Still return 200 to Twilio to avoid retries, but log the error
        return "Error logged"

    # Broadcast new lead creation event if auto-created
    if is_new_lead and new_lead and wa_log.dealership_id:
        try:
            # Broadcast lead:created event for unassigned pool and conversation list
            await ws_manager.broadcast_to_dealership(
                str(wa_log.dealership_id),
                {
                    "type": "lead:created",
                    "payload": {
                        "lead_id": str(new_lead.id),
                        "customer_id": str(new_lead.customer_id),
                        "phone": from_number,
                        "source": "whatsapp_inbound",
                        "assigned_to": None,  # Unassigned
                        "is_whatsapp_lead": True,
                    },
                },
            )
            logger.info(f"Broadcast lead:created for new WhatsApp lead {new_lead.id}")
        except Exception as e:
            logger.warning("lead:created broadcast failed: %s", e, exc_info=True)

    # Broadcast whatsapp:received for the message
    if wa_log.lead_id and wa_log.dealership_id:
        try:
            # Get total unread count for the dealership to include in broadcast
            from app.models.whatsapp_log import WhatsAppLog, WhatsAppDirection
            unread_query = select(func.count()).select_from(WhatsAppLog).where(
                WhatsAppLog.dealership_id == wa_log.dealership_id,
                WhatsAppLog.direction == WhatsAppDirection.INBOUND,
                WhatsAppLog.is_read == False
            )
            unread_result = await db.execute(unread_query)
            total_unread = unread_result.scalar() or 0
            
            await ws_manager.broadcast_to_dealership(
                str(wa_log.dealership_id),
                {
                    "type": "whatsapp:received",
                    "payload": {
                        "message_id": str(wa_log.id),
                        "lead_id": str(wa_log.lead_id),
                        "from_number": from_number,
                        "body_preview": body[:100] if body else "",
                        "has_media": len(media_urls) > 0,
                        "is_new_lead": is_new_lead,
                        "total_unread": total_unread,
                        "message": {
                            "id": str(wa_log.id),
                            "lead_id": str(wa_log.lead_id),
                            "user_id": str(wa_log.user_id) if wa_log.user_id else None,
                            "direction": wa_log.direction.value,
                            "from_number": wa_log.from_number,
                            "to_number": wa_log.to_number,
                            "body": wa_log.body,
                            "status": wa_log.status.value,
                            "is_read": wa_log.is_read,
                            "created_at": wa_log.created_at.isoformat() if wa_log.created_at else None,
                            "sent_at": wa_log.sent_at.isoformat() if wa_log.sent_at else None,
                            "delivered_at": wa_log.delivered_at.isoformat() if wa_log.delivered_at else None,
                            "media_urls": wa_log.media_urls or [],
                            "media_content_types": wa_log.media_content_types or [],
                        },
                    },
                },
            )
        except Exception as e:
            logger.warning("whatsapp:received broadcast failed: %s", e, exc_info=True)
    elif not wa_log.lead_id and wa_log.dealership_id:
        # Fallback: If lead creation failed, broadcast to unknown tab
        try:
            await ws_manager.broadcast_to_dealership(
                str(wa_log.dealership_id),
                {
                    "type": "whatsapp:unknown_received",
                    "payload": {
                        "message_id": str(wa_log.id),
                        "from_number": from_number,
                        "body_preview": body[:100] if body else "",
                        "has_media": len(media_urls) > 0,
                        "message": {
                            "id": str(wa_log.id),
                            "direction": "inbound",
                            "from_number": wa_log.from_number,
                            "to_number": wa_log.to_number,
                            "body": wa_log.body,
                            "status": wa_log.status.value if wa_log.status else "received",
                            "media_urls": wa_log.media_urls or [],
                            "media_content_types": wa_log.media_content_types or [],
                            "created_at": wa_log.created_at.isoformat() if wa_log.created_at else None,
                        },
                    },
                },
            )
        except Exception as e:
            logger.warning("whatsapp:unknown_received broadcast failed: %s", e, exc_info=True)

    # Send notifications for WhatsApp messages
    # Use separate try-except with rollback to ensure notification failures don't affect message storage
    if wa_log.dealership_id and wa_log.lead_id:
        try:
            notification_service = NotificationService(db)
            from app.models.user import User, UserRole
            
            # Get the lead to check assignment status
            lead_result = await db.execute(
                select(Lead).options(selectinload(Lead.customer)).where(Lead.id == wa_log.lead_id)
            )
            lead = lead_result.scalar_one_or_none()
            lead_name = f"{lead.first_name} {lead.last_name or ''}".strip() if lead else "Unknown"
            
            from app.models.notification import NotificationType
            
            if lead and lead.assigned_to:
                # Lead is assigned - notify only the assigned salesperson
                # Send push immediately, schedule delayed email (only if unread after 3 min)
                notif_title = "New WhatsApp Message"
                notif_message = f"Message from {lead_name}: {body[:50]}..." if len(body) > 50 else f"Message from {lead_name}: {body}"
                notif_link = f"/whatsapp?lead={wa_log.lead_id}"
                notif_meta = {
                    "lead_id": str(wa_log.lead_id),
                    "message_id": str(wa_log.id),
                    "from_number": from_number,
                }
                
                await notification_service.create_notification(
                    user_id=lead.assigned_to,
                    title=notif_title,
                    message=notif_message,
                    link=notif_link,
                    notification_type=NotificationType.WHATSAPP_RECEIVED,
                    meta_data=notif_meta,
                    send_push=True,
                    send_email=False,  # Don't send email immediately
                    send_sms=False
                )
                
                # Schedule delayed email (only sent if message still unread after 3 minutes)
                asyncio.create_task(send_delayed_whatsapp_email(
                    message_id=wa_log.id,
                    user_id=lead.assigned_to,
                    title=notif_title,
                    message=notif_message,
                    link=notif_link,
                    notification_type_value=NotificationType.WHATSAPP_RECEIVED.value,
                    meta_data=notif_meta
                ))
            else:
                # Lead is unassigned - notify ALL salespeople, admins, and owners in the dealership
                users_query = select(User).where(
                    User.dealership_id == wa_log.dealership_id,
                    User.is_active == True,
                    User.role.in_([UserRole.SALESPERSON, UserRole.DEALERSHIP_ADMIN, UserRole.DEALERSHIP_OWNER])
                )
                users_result = await db.execute(users_query)
                users = users_result.scalars().all()
                
                notification_title = "New WhatsApp Lead" if is_new_lead else "New WhatsApp Message (Unassigned)"
                notif_type = NotificationType.WHATSAPP_NEW_LEAD if is_new_lead else NotificationType.WHATSAPP_RECEIVED
                notification_message = f"Message from {from_number}: {body[:50]}..." if len(body) > 50 else f"Message from {from_number}: {body}"
                notif_link = f"/whatsapp?lead={wa_log.lead_id}"
                
                # Send push notifications to all users in parallel (no email immediately)
                notification_tasks = [
                    notification_service.create_notification(
                        user_id=user.id,
                        title=notification_title,
                        message=notification_message,
                        link=notif_link,
                        notification_type=notif_type,
                        meta_data={
                            "lead_id": str(wa_log.lead_id),
                            "message_id": str(wa_log.id),
                            "from_number": from_number,
                            "is_new_lead": is_new_lead,
                            "is_unassigned": True,
                        },
                        send_push=True,
                        send_email=False,  # Don't send email immediately
                        send_sms=False
                    )
                    for user in users
                ]
                
                # Schedule delayed emails for all users (only sent if message still unread after 3 minutes)
                for user in users:
                    asyncio.create_task(send_delayed_whatsapp_email(
                        message_id=wa_log.id,
                        user_id=user.id,
                        title=notification_title,
                        message=notification_message,
                        link=notif_link,
                        notification_type_value=notif_type.value,
                        meta_data={
                            "lead_id": str(wa_log.lead_id),
                            "message_id": str(wa_log.id),
                            "from_number": from_number,
                            "is_new_lead": is_new_lead,
                            "is_unassigned": True,
                        }
                    ))
                await asyncio.gather(*notification_tasks, return_exceptions=True)
            await db.commit()
        except Exception as e:
            await db.rollback()  # Rollback to reset session state
            logger.warning("WhatsApp notification failed (message already stored): %s", e, exc_info=True)

    return Response(
        content='<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        media_type="application/xml"
    )


@router.post("/whatsapp/status")
async def handle_whatsapp_status(
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    Twilio webhook for WhatsApp message delivery status updates.
    Updates the message status in the database and broadcasts to the frontend.
    """
    form_data = await request.form()
    message_sid = form_data.get("MessageSid", "")
    message_status = form_data.get("MessageStatus", "")
    error_code = form_data.get("ErrorCode")
    error_message = form_data.get("ErrorMessage")

    logger.info(f"WhatsApp status webhook: {message_sid} -> {message_status}")

    service = get_whatsapp_conversation_service(db)
    wa_log = await service.update_delivery_status(
        message_sid=message_sid,
        status=message_status,
        error_code=error_code,
        error_message=error_message,
    )

    # Commit first to ensure data is persisted before broadcasting
    await db.commit()
    
    # Then broadcast the status update
    if wa_log and wa_log.lead_id and wa_log.dealership_id:
        try:
            await ws_manager.broadcast_to_dealership(
                str(wa_log.dealership_id),
                {
                    "type": "whatsapp:status",
                    "payload": {
                        "message_id": str(wa_log.id),
                        "lead_id": str(wa_log.lead_id),
                        "status": message_status,
                        "delivered_at": wa_log.delivered_at.isoformat() if wa_log.delivered_at else None,
                        "read_at": wa_log.read_at.isoformat() if hasattr(wa_log, "read_at") and wa_log.read_at else None,
                    },
                },
            )
        except Exception as e:
            logger.warning("whatsapp:status broadcast failed: %s", e, exc_info=True)

    return {"status": "ok"}
