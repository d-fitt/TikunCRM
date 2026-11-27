"""
SMS API Endpoints - Conversation-style messaging
"""
import logging
from datetime import datetime
from typing import Any, Dict, Optional, List
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.orm.attributes import flag_modified

from app.api import deps
from app.services.dealership_twilio_config_service import get_effective_twilio_config
from app.core.permissions import UserRole
from app.core.access_scope import get_accessible_dealership_ids, user_can_access_lead
from app.db.database import get_db
from app.models.user import User
from app.models.sms_log import SMSLog, MessageDirection
from app.models.call_log import CallLog
from app.models.lead import Lead
from app.models.customer import Customer
from app.models.sms_broadcast import SMSBroadcast
from app.services import sms_consent_service as sms_consent
from app.services import sms_broadcast_service as broadcasts
from app.services.sms_conversation_service import SMSConversationService, get_sms_conversation_service
from app.core.websocket_manager import ws_manager
from app.core.config import settings

logger = logging.getLogger(__name__)

router = APIRouter()


# ============ Schemas ============

class SMSConfigResponse(BaseModel):
    """SMS configuration status"""
    sms_enabled: bool
    phone_number: Optional[str]
    promo_enabled: bool = False
    auto_first_message_enabled: bool = False


class SendSMSRequest(BaseModel):
    """Request to send SMS or MMS"""
    to_number: str = Field("", description="Phone number to send to")
    body: str = Field("", max_length=1600, description="Message body")
    lead_id: Optional[UUID] = Field(None, description="Optional lead ID")
    media_urls: List[str] = Field(default_factory=list, description="Optional MMS media URLs")
    media_content_types: List[str] = Field(default_factory=list, description="Optional MMS media MIME types")


class SendSMSResponse(BaseModel):
    """Response for SMS send"""
    success: bool
    message_id: Optional[UUID] = None
    error: Optional[str] = None


class SMSMessageResponse(BaseModel):
    """Single SMS message"""
    id: UUID
    lead_id: Optional[UUID]
    user_id: Optional[UUID]
    sender_name: Optional[str] = None
    direction: str
    from_number: str
    to_number: str
    body: str
    status: str
    is_read: bool
    created_at: datetime
    sent_at: Optional[datetime]
    delivered_at: Optional[datetime]
    category: Optional[str] = None
    error_message: Optional[str] = None
    media_urls: List[str] = Field(default_factory=list)
    media_content_types: List[str] = Field(default_factory=list)
    reactions: Dict[str, List[str]] = Field(default_factory=dict)
    
    class Config:
        from_attributes = True


class SMSCallLogResponse(BaseModel):
    """Call log record included in SMS conversation timeline"""
    id: UUID
    direction: str
    from_number: str
    to_number: str
    status: str
    duration_seconds: int = 0
    recording_url: Optional[str] = None
    recording_duration_seconds: Optional[int] = None
    notes: Optional[str] = None
    outcome: Optional[str] = None
    started_at: datetime
    answered_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class SMSConsentStatus(BaseModel):
    """What the customer agreed to and whether an agent may text them"""
    inquiry_consent: Optional[bool]
    promo_consent: Optional[bool]
    source: Optional[str]
    consent_at: Optional[datetime]
    opted_out: bool
    opted_out_at: Optional[datetime]
    can_text: bool
    block_reason: Optional[str]


class ConversationResponse(BaseModel):
    """SMS conversation with lead"""
    lead_id: UUID
    lead_name: str
    lead_phone: Optional[str]
    messages: List[SMSMessageResponse]
    calls: List[SMSCallLogResponse] = Field(default_factory=list)
    consent: Optional[SMSConsentStatus] = None


class ConversationListItem(BaseModel):
    """Conversation list item"""
    lead_id: str
    lead_name: str
    lead_phone: Optional[str]
    last_message: dict
    unread_count: int


class ConversationTabCounts(BaseModel):
    all: int = 0
    unread: int = 0
    automatic: int = 0
    campaigns: int = 0


class CampaignDeliveryCounts(BaseModel):
    """Offer-campaign texts by what the carrier reported."""
    delivered: int = 0
    sent: int = 0
    undelivered: int = 0
    failed: int = 0


class ConversationsListResponse(BaseModel):
    """List of conversations"""
    items: List[ConversationListItem]
    total_unread: int
    counts: ConversationTabCounts = Field(default_factory=ConversationTabCounts)
    delivery: CampaignDeliveryCounts = Field(default_factory=CampaignDeliveryCounts)


class UnreadCountResponse(BaseModel):
    """Unread message count"""
    count: int


def _consent_status(customer: Optional[Customer]) -> Optional[SMSConsentStatus]:
    if customer is None:
        return None
    reason = sms_consent.send_block_reason(customer, sms_consent.CATEGORY_CONVERSATION)
    return SMSConsentStatus(
        inquiry_consent=customer.sms_inquiry_consent,
        promo_consent=customer.sms_promo_consent,
        source=customer.sms_consent_source,
        consent_at=customer.sms_consent_at,
        opted_out=bool(customer.sms_opted_out),
        opted_out_at=customer.sms_opted_out_at,
        can_text=reason is None,
        block_reason=reason,
    )


async def _broadcast_sms_read(lead: Lead) -> None:
    if not lead.dealership_id:
        return
    await ws_manager.broadcast_to_dealership(
        str(lead.dealership_id),
        {"type": "sms:read", "payload": {"lead_id": str(lead.id)}},
    )
    from app.db.database import async_session_maker
    from app.services.sms_unread_realtime import push_sms_unread_for_dealership

    async with async_session_maker() as db:
        await push_sms_unread_for_dealership(db, str(lead.dealership_id))


# ============ Endpoints ============

@router.get("/config", response_model=SMSConfigResponse)
async def get_sms_config(
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """Get SMS configuration status"""
    effective = await get_effective_twilio_config(db, current_user.dealership_id)
    return SMSConfigResponse(
        sms_enabled=effective.is_sms_ready(),
        phone_number=effective.sms_from_number if effective.is_sms_ready() else None,
        promo_enabled=effective.is_sms_ready() and effective.sms_promo_enabled,
        auto_first_message_enabled=effective.is_sms_ready() and effective.sms_auto_first_message_enabled,
    )


@router.post("/send", response_model=SendSMSResponse)
async def send_sms(
    request: SendSMSRequest,
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    """Send an SMS message"""
    effective = await get_effective_twilio_config(db, current_user.dealership_id)
    if not effective.is_sms_ready():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SMS is not configured"
        )

    service = get_sms_conversation_service(db)
    
    success, sms_log, error = await service.send_sms(
        to_number=request.to_number,
        body=request.body,
        user_id=current_user.id,
        lead_id=request.lead_id,
        dealership_id=current_user.dealership_id
    )
    
    await db.commit()
    
    if success and sms_log:
        # Send real-time update
        if sms_log.lead_id:
            await ws_manager.broadcast_to_dealership(
                str(sms_log.dealership_id) if sms_log.dealership_id else None,
                {
                    "type": "sms:sent",
                    "payload": {
                        "message_id": str(sms_log.id),
                        "lead_id": str(sms_log.lead_id),
                        "body_preview": sms_log.body[:50] if sms_log.body else ""
                    }
                }
            )
        
        return SendSMSResponse(
            success=True,
            message_id=sms_log.id
        )
    
    return SendSMSResponse(
        success=False,
        error=error
    )


class LeadSearchItem(BaseModel):
    lead_id: UUID
    lead_name: str
    lead_phone: Optional[str]


@router.get("/leads/search", response_model=List[LeadSearchItem])
async def search_leads_for_sms(
    q: str = Query(..., min_length=2, max_length=100),
    limit: int = Query(20, ge=1, le=50),
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """Find leads by name or phone (any format) to start a text. One row per customer, newest lead."""
    if not current_user.dealership_id:
        return []
    term = q.strip()
    full_name = func.concat_ws(" ", Customer.first_name, Customer.last_name)
    conditions = [full_name.ilike(f"%{term}%")]
    digits = "".join(ch for ch in term if ch.isdigit())
    if len(digits) >= 3:
        conditions.append(func.regexp_replace(Customer.phone, r"\D", "", "g").like(f"%{digits}%"))
    rows = (
        await db.execute(
            select(Lead.id, Customer.first_name, Customer.last_name, Customer.phone)
            .join(Customer, Lead.customer_id == Customer.id)
            .where(
                Lead.dealership_id == current_user.dealership_id,
                Customer.phone.isnot(None),
                Customer.phone != "",
                or_(*conditions),
            )
            .distinct(Customer.id)
            .order_by(Customer.id, Lead.created_at.desc())
            .limit(limit)
        )
    ).all()
    return [
        LeadSearchItem(
            lead_id=lead_id,
            lead_name=f"{first or ''} {last or ''}".strip() or "Unknown",
            lead_phone=phone,
        )
        for lead_id, first, last, phone in rows
    ]


@router.get("/conversations", response_model=ConversationsListResponse)
async def list_conversations(
    unread_only: bool = Query(False),
    view: str = Query("all"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    """List SMS conversations. view is all, unread, automatic, or campaigns."""
    service = get_sms_conversation_service(db)
    if view not in ("all", "unread", "automatic", "campaigns"):
        view = "all"

    # Apply role-based filtering
    user_id = None
    dealership_id = None
    
    dealership_ids = None
    if current_user.role == UserRole.SALESPERSON:
        user_id = current_user.id
    elif current_user.role in [UserRole.DEALERSHIP_ADMIN, UserRole.DEALERSHIP_OWNER]:
        dealership_id = current_user.dealership_id
    elif current_user.role == UserRole.BDC:
        dealership_ids = await get_accessible_dealership_ids(db, current_user)

    scope = dict(user_id=user_id, dealership_id=dealership_id, dealership_ids=dealership_ids)
    conversations = await service.get_conversations_list(
        unread_only=unread_only,
        view=view,
        limit=limit,
        offset=offset,
        **scope,
    )

    total_unread = await service.get_unread_count(**scope)
    counts = await service.conversation_tab_counts(**scope)
    delivery = await service.promotional_delivery_counts(**scope)

    return ConversationsListResponse(
        items=[ConversationListItem(**c) for c in conversations],
        total_unread=total_unread,
        counts=ConversationTabCounts(**counts),
        delivery=CampaignDeliveryCounts(**delivery),
    )


@router.get("/conversations/{lead_id}", response_model=ConversationResponse)
async def get_conversation(
    lead_id: UUID,
    limit: int = Query(50, ge=1, le=100),
    before: Optional[datetime] = None,
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    """Get SMS conversation with a lead (returns full customer-level history)."""
    # Verify access to lead and load customer for name/phone
    result = await db.execute(
        select(Lead).options(selectinload(Lead.customer)).where(Lead.id == lead_id)
    )
    lead = result.scalar_one_or_none()
    
    if not lead:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Lead not found"
        )
    
    # Check access
    if not await user_can_access_lead(db, current_user, lead.dealership_id, lead.assigned_to):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied",
        )
    
    service = get_sms_conversation_service(db)
    
    messages = await service.get_conversation(
        lead_id=lead_id,
        limit=limit,
        before=before
    )

    # Fetch call logs for this customer/lead so inbound & outbound calls appear in the thread
    call_query = select(CallLog)
    if lead.customer_id:
        call_query = call_query.where(
            or_(CallLog.customer_id == lead.customer_id, CallLog.lead_id == lead.id)
        )
    else:
        call_query = call_query.where(CallLog.lead_id == lead.id)
    if before:
        call_query = call_query.where(CallLog.started_at < before)
    call_query = call_query.order_by(CallLog.started_at.desc()).limit(limit)
    call_rows = list(reversed((await db.execute(call_query)).scalars().all()))
    
    # Mark messages & any unread SMS notifications for this lead as read
    newly_read = await service.mark_conversation_as_read(lead_id)
    from sqlalchemy import update as sql_update
    from app.models.notification import Notification, NotificationType
    from app.core.timezone import utc_now
    await db.execute(
        sql_update(Notification)
        .where(
            Notification.user_id == current_user.id,
            Notification.type == NotificationType.SMS_RECEIVED,
            Notification.is_read.is_(False),
            Notification.link == f"/sms?lead={lead_id}",
        )
        .values(is_read=True, read_at=utc_now())
    )
    await db.commit()

    if newly_read:
        await _broadcast_sms_read(lead)

    sender_ids = {msg.user_id for msg in messages if msg.user_id}
    sender_names: Dict[UUID, str] = {}
    if sender_ids:
        sender_rows = (
            await db.execute(select(User).where(User.id.in_(sender_ids)))
        ).scalars().all()
        sender_names = {
            u.id: f"{u.first_name or ''} {u.last_name or ''}".strip() or u.email
            for u in sender_rows
        }
    
    return ConversationResponse(
        lead_id=lead.id,
        lead_name=f"{lead.first_name} {lead.last_name or ''}".strip(),
        lead_phone=lead.phone,
        consent=_consent_status(lead.customer),
        messages=[
            SMSMessageResponse(
                id=msg.id,
                lead_id=msg.lead_id,
                user_id=msg.user_id,
                sender_name=sender_names.get(msg.user_id) if msg.user_id else None,
                direction=msg.direction.value,
                from_number=msg.from_number,
                to_number=msg.to_number,
                body=msg.body,
                status=msg.status.value,
                is_read=msg.is_read,
                created_at=msg.created_at,
                sent_at=msg.sent_at,
                delivered_at=msg.delivered_at,
                category=msg.category,
                error_message=msg.error_message,
                media_urls=list(msg.media_urls or []) if isinstance(msg.media_urls, list) else [],
                media_content_types=list((msg.meta_data or {}).get("media_content_types") or []),
                reactions=dict((msg.meta_data or {}).get("reactions") or {}),
            )
            for msg in messages
        ],
        calls=[
            SMSCallLogResponse(
                id=call.id,
                direction=call.direction.value,
                from_number=call.from_number,
                to_number=call.to_number,
                status=call.status.value,
                duration_seconds=call.duration_seconds or 0,
                recording_url=call.recording_url,
                recording_duration_seconds=call.recording_duration_seconds,
                notes=call.notes,
                outcome=call.outcome,
                started_at=call.started_at,
                answered_at=call.answered_at,
                ended_at=call.ended_at,
            )
            for call in call_rows
        ],
    )


@router.post("/conversations/{lead_id}/send", response_model=SendSMSResponse)
async def send_to_lead(
    lead_id: UUID,
    request: SendSMSRequest,
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    """Send SMS to a specific lead"""
    # Verify access to lead
    result = await db.execute(
        select(Lead).where(Lead.id == lead_id)
    )
    lead = result.scalar_one_or_none()
    
    if not lead:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Lead not found"
        )
    
    if not lead.phone:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Lead has no phone number"
        )
    
    if not await user_can_access_lead(db, current_user, lead.dealership_id, lead.assigned_to):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied",
        )

    if not request.body.strip() and not request.media_urls:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Enter a message or attach media",
        )

    service = get_sms_conversation_service(db)

    success, sms_log, error = await service.send_sms(
        to_number=lead.phone,
        body=request.body,
        user_id=current_user.id,
        lead_id=lead.id,
        dealership_id=lead.dealership_id,
        media_urls=request.media_urls or None,
        media_content_types=request.media_content_types or None,
    )
    
    await db.commit()
    
    if success and sms_log:
        # Send real-time update
        await ws_manager.broadcast_to_dealership(
            str(lead.dealership_id) if lead.dealership_id else None,
            {
                "type": "sms:sent",
                "payload": {
                    "message_id": str(sms_log.id),
                    "lead_id": str(lead.id),
                    "body_preview": sms_log.body[:50] if sms_log.body else ""
                }
            }
        )
        
        return SendSMSResponse(
            success=True,
            message_id=sms_log.id
        )
    
    return SendSMSResponse(
        success=False,
        error=error
    )


@router.patch("/messages/{message_id}/read")
async def mark_message_read(
    message_id: UUID,
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    """Mark a message as read"""
    service = get_sms_conversation_service(db)
    
    sms_log = await service.mark_as_read(message_id)
    
    if not sms_log:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Message not found"
        )
    
    await db.commit()

    if sms_log.lead_id and sms_log.dealership_id:
        await ws_manager.broadcast_to_dealership(
            str(sms_log.dealership_id),
            {"type": "sms:read", "payload": {"lead_id": str(sms_log.lead_id)}},
        )
        from app.services.sms_unread_realtime import push_sms_unread_for_dealership

        await push_sms_unread_for_dealership(db, str(sms_log.dealership_id))
    
    return {"status": "ok"}


_SMS_ALLOWED_MEDIA_TYPES = {
    # Images
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    # Video
    "video/mp4",
    "video/3gpp",
    "video/quicktime",
    "video/webm",
    # Audio / Voice
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/x-m4a",
    "audio/m4a",
    "audio/aac",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/webm",
    "audio/amr",
    "audio/3gpp",
    # Documents
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/csv",
    "text/vcard",
    "text/x-vcard",
}
_SMS_MAX_MEDIA_SIZE = 5 * 1024 * 1024  # 5MB Twilio MMS limit


class UploadSMSMediaResponse(BaseModel):
    url: str
    content_type: str
    filename: str


@router.post("/upload-media", response_model=UploadSMSMediaResponse)
async def upload_sms_media(
    file: UploadFile = File(...),
    current_user: User = Depends(deps.get_current_active_user),
):
    """Upload an image, video, audio, or document for sending via MMS (max 5MB)."""
    from app.services.azure_storage_service import azure_storage_service

    if not azure_storage_service.is_whatsapp_media_configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Media storage not configured",
        )

    content_type = (file.content_type or "application/octet-stream").split(";")[0].strip().lower()
    if content_type not in _SMS_ALLOWED_MEDIA_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type ({content_type}). Allowed: images, videos, audio (MP3/M4A/OGG/WAV/WebM), PDF, and documents.",
        )

    content = await file.read()
    if len(content) > _SMS_MAX_MEDIA_SIZE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File is too large for MMS. Maximum size is 5MB.",
        )

    filename = file.filename or "media"
    url = await azure_storage_service.upload_whatsapp_media(
        data=content,
        filename=filename,
        content_type=content_type,
        dealership_id=current_user.dealership_id,
    )
    if not url:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to upload media",
        )
    return UploadSMSMediaResponse(url=url, content_type=content_type, filename=filename)


class ReactionRequest(BaseModel):
    emoji: str = Field(..., min_length=1, max_length=16)


class ReactionResponse(BaseModel):
    message_id: UUID
    reactions: Dict[str, List[str]]


_TAPBACK_VERBS = {
    "👍": "Liked",
    "❤️": "Loved",
    "❤": "Loved",
    "😂": "Laughed at",
    "👎": "Disliked",
    "❗": "Emphasized",
    "❓": "Questioned",
}


def _format_tapback_sms(emoji: str, target_body: str, has_media: bool) -> str:
    snippet = (target_body or "").strip()
    if len(snippet) > 80:
        snippet = snippet[:77] + "..."
    verb = _TAPBACK_VERBS.get(emoji)
    if snippet:
        if verb:
            return f'{verb} “{snippet}”'
        return f'Reacted {emoji} to “{snippet}”'
    noun = "an attachment" if has_media else "a message"
    if verb:
        return f"{verb} {noun}"
    return f"Reacted {emoji} to {noun}"


@router.post("/messages/{message_id}/react", response_model=ReactionResponse)
async def toggle_sms_reaction(
    message_id: UUID,
    request: ReactionRequest,
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Toggle an emoji reaction on an SMS message.
    When adding a reaction, also sends a standard SMS tapback (e.g. Liked “...”)
    so Google Messages and iPhone render the reaction on the customer's phone.
    """
    sms_log = await db.get(SMSLog, message_id)
    if not sms_log:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    lead = None
    if sms_log.lead_id:
        lead = await db.get(Lead, sms_log.lead_id)
        if lead and not await user_can_access_lead(db, current_user, lead.dealership_id, lead.assigned_to):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    meta = dict(sms_log.meta_data or {})
    reactions: Dict[str, List[str]] = {
        k: list(v) for k, v in (meta.get("reactions") or {}).items() if isinstance(v, list)
    }
    actor = current_user.full_name or current_user.email
    emoji = request.emoji.strip()
    users = reactions.get(emoji, [])
    added = False
    if actor in users:
        users = [u for u in users if u != actor]
        if users:
            reactions[emoji] = users
        else:
            reactions.pop(emoji, None)
    else:
        users.append(actor)
        reactions[emoji] = users
        added = True

    meta["reactions"] = reactions
    sms_log.meta_data = meta
    flag_modified(sms_log, "meta_data")
    await db.commit()

    # Send standard SMS tapback to the customer's phone when adding a reaction
    if added:
        to_phone = (
            sms_log.from_number
            if sms_log.direction == MessageDirection.INBOUND
            else sms_log.to_number
        )
        customer = await db.get(Customer, sms_log.customer_id) if sms_log.customer_id else None
        dealership_id = sms_log.dealership_id or (lead.dealership_id if lead else current_user.dealership_id)
        effective = await get_effective_twilio_config(db, dealership_id)
        blocked = sms_consent.send_block_reason(customer, sms_consent.CATEGORY_CONVERSATION, effective.sms_promo_enabled)
        if to_phone and effective.is_sms_ready() and not blocked:
            from app.services.sms_service import sms_service
            tapback_text = _format_tapback_sms(emoji, sms_log.body, bool(sms_log.media_urls))
            try:
                await sms_service.send_sms(to_phone, tapback_text, effective)
            except Exception as exc:
                logger.warning("Failed to send SMS tapback reaction: %s", exc)

    if sms_log.lead_id:
        await ws_manager.broadcast_to_dealership(
            str(sms_log.dealership_id) if sms_log.dealership_id else None,
            {
                "type": "sms:reaction",
                "payload": {
                    "message_id": str(sms_log.id),
                    "lead_id": str(sms_log.lead_id),
                    "reactions": reactions,
                },
            },
        )
    return ReactionResponse(message_id=sms_log.id, reactions=reactions)


@router.get("/unread-count", response_model=UnreadCountResponse)
async def get_unread_count(
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    """Get unread SMS count for current user"""
    service = get_sms_conversation_service(db)
    
    user_id = None
    dealership_id = None
    dealership_ids = None

    if current_user.role == UserRole.SALESPERSON:
        user_id = current_user.id
    elif current_user.role in [UserRole.DEALERSHIP_ADMIN, UserRole.DEALERSHIP_OWNER]:
        dealership_id = current_user.dealership_id
    elif current_user.role == UserRole.BDC:
        dealership_ids = await get_accessible_dealership_ids(db, current_user)

    count = await service.get_unread_count(
        user_id=user_id,
        dealership_id=dealership_id,
        dealership_ids=dealership_ids,
    )
    
    return UnreadCountResponse(count=count)


@router.post("/conversations/{lead_id}/opt-out", response_model=SMSConsentStatus)
async def mark_customer_opted_out(
    lead_id: UUID,
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """Stop all texts to this customer (e.g. they asked by phone). Only the customer can undo it by texting START."""
    lead = (
        await db.execute(select(Lead).options(selectinload(Lead.customer)).where(Lead.id == lead_id))
    ).scalar_one_or_none()
    if not lead or not lead.customer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lead not found")
    if not await user_can_access_lead(db, current_user, lead.dealership_id, lead.assigned_to):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    sms_consent.mark_opted_out(lead.customer)
    lead.customer.sms_consent_source = "agent_marked_opt_out"
    from app.services.activity import ActivityService
    from app.models.activity import ActivityType
    await ActivityService.log_activity(
        db=db,
        activity_type=ActivityType.LEAD_UPDATED,
        description="Marked as do not text",
        user_id=current_user.id,
        lead_id=lead.id,
        dealership_id=lead.dealership_id,
        meta_data={"sms_opted_out": True},
    )
    await db.commit()
    return _consent_status(lead.customer)


# ============ Promotional campaigns ============

class CampaignFiltersSchema(BaseModel):
    stage_ids: List[str] = Field(default_factory=list)
    campaigns: List[str] = Field(default_factory=list)
    sources: List[str] = Field(default_factory=list)
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    has_stips: Optional[bool] = None
    assigned_to: Optional[str] = None
    min_down_payment: Optional[float] = None
    only_active: bool = False
    exclude_contacted_in_days: Optional[int] = None
    search: Optional[str] = None


class CampaignBodyRequest(BaseModel):
    name: Optional[str] = Field(None, max_length=160)
    body: str = Field(..., min_length=1, max_length=1000)
    media_urls: List[str] = Field(default_factory=list)
    filters: CampaignFiltersSchema = Field(default_factory=CampaignFiltersSchema)
    save_as_draft: bool = False
    scheduled_at: Optional[datetime] = None


class CampaignAudiencePreviewRequest(BaseModel):
    filters: CampaignFiltersSchema = Field(default_factory=CampaignFiltersSchema)
    limit: int = Field(25, ge=1, le=100)


class CampaignTestSendRequest(BaseModel):
    to_number: str = Field(..., min_length=7, max_length=30)
    body: str = Field(..., min_length=1, max_length=1000)
    media_urls: List[str] = Field(default_factory=list)
    sample_first_name: str = "María"


class CampaignPreviewResponse(BaseModel):
    final_body: str
    sample: str
    segments: int
    characters: int
    blocked_links: List[str]
    audience: int
    is_mms: bool = False


class CampaignResponse(BaseModel):
    id: UUID
    name: Optional[str] = None
    body: str
    media_urls: List[str] = Field(default_factory=list)
    filters: Dict[str, Any] = Field(default_factory=dict)
    status: str
    scheduled_at: Optional[datetime] = None
    total_recipients: int
    sent_count: int
    failed_count: int
    skipped_count: int
    delivered_count: int = 0
    undelivered_count: int = 0
    pending_count: int = 0
    created_at: datetime
    completed_at: Optional[datetime]
    created_by_name: Optional[str] = None


class CampaignOverviewResponse(BaseModel):
    promo_enabled: bool
    audience: int
    in_send_window: bool
    send_window: str
    timezone: str


def _campaign_response(b: SMSBroadcast, names: dict, delivery: Optional[dict] = None) -> CampaignResponse:
    stats = delivery or {}
    return CampaignResponse(
        id=b.id,
        name=b.name,
        body=b.body,
        media_urls=list(b.media_urls or []) if isinstance(b.media_urls, list) else [],
        filters=dict(b.filters or {}) if isinstance(b.filters, dict) else {},
        status=b.status,
        scheduled_at=b.scheduled_at,
        total_recipients=b.total_recipients,
        sent_count=b.sent_count,
        failed_count=b.failed_count,
        skipped_count=b.skipped_count,
        delivered_count=int(stats.get("delivered", 0)),
        undelivered_count=int(stats.get("undelivered", 0)),
        pending_count=int(stats.get("pending", 0)),
        created_at=b.created_at,
        completed_at=b.completed_at,
        created_by_name=names.get(b.created_by),
    )


def _company_id(user: User) -> UUID:
    if not user.dealership_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Your account isn't linked to the company")
    return user.dealership_id


async def _require_promo_enabled(db: AsyncSession, dealership_id: UUID) -> None:
    effective = await get_effective_twilio_config(db, dealership_id)
    if not effective.is_sms_ready():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="SMS is not set up")
    if not effective.sms_promo_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Promotional texts are turned off. A Super Admin can turn them on in Settings > Twilio.",
        )


@router.get("/campaigns/overview", response_model=CampaignOverviewResponse)
async def campaign_overview(
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    dealership_id = _company_id(current_user)
    effective = await get_effective_twilio_config(db, dealership_id)
    tz = await broadcasts.dealership_timezone(db, dealership_id)
    return CampaignOverviewResponse(
        promo_enabled=effective.is_sms_ready() and effective.sms_promo_enabled,
        audience=await broadcasts.audience_count(db, dealership_id),
        in_send_window=broadcasts.in_send_window(tz),
        send_window=f"{broadcasts.SEND_WINDOW_START_HOUR}:00 AM - {broadcasts.SEND_WINDOW_END_HOUR - 12}:00 PM",
        timezone=str(tz),
    )


@router.get("/campaigns/filter-options")
async def campaign_filter_options(
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    dealership_id = _company_id(current_user)
    return await broadcasts.get_filter_options(db, dealership_id)


@router.post("/campaigns/audience-preview")
async def campaign_audience_preview(
    request: CampaignAudiencePreviewRequest,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    dealership_id = _company_id(current_user)
    return await broadcasts.audience_preview(
        db, dealership_id, request.filters.model_dump(exclude_none=True), limit=request.limit
    )


@router.post("/campaigns/preview", response_model=CampaignPreviewResponse)
async def preview_campaign(
    request: CampaignBodyRequest,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    dealership_id = _company_id(current_user)
    filters_dict = request.filters.model_dump(exclude_none=True)
    return CampaignPreviewResponse(
        **broadcasts.preview(request.body, media_urls=request.media_urls),
        audience=await broadcasts.audience_count(db, dealership_id, filters_dict),
    )


@router.post("/campaigns/test-send")
async def test_send_campaign(
    request: CampaignTestSendRequest,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Send a single test SMS/MMS to your own phone to preview how the offer looks."""
    dealership_id = _company_id(current_user)
    effective = await get_effective_twilio_config(db, dealership_id)
    if not effective.is_sms_ready():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="SMS is not set up")
    bad = sms_consent.disallowed_link_hosts(request.body)
    if bad:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Only links to {settings.sms_allowed_link_domains} are allowed. Remove: {', '.join(bad)}",
        )
    from app.models.dealership import Dealership
    dealership = await db.get(Dealership, dealership_id)
    store_address = None
    if dealership:
        parts = [p for p in (dealership.address, dealership.city, dealership.state) if p]
        store_address = ", ".join(parts) if parts else None

    rendered = sms_consent.personalize(
        broadcasts.build_body(request.body),
        request.sample_first_name,
        last_name="García",
        vehicle="2022 Toyota RAV4",
        down_payment=2000,
        agent_name=current_user.full_name,
        dealership_name=dealership.name if dealership else None,
        dealership_phone=dealership.phone if dealership else None,
        dealership_address=store_address,
    )
    from app.services.sms_service import sms_service
    res = await sms_service.send_sms(
        request.to_number, rendered, effective, media_urls=request.media_urls or None
    )
    if not res.get("success"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=res.get("error") or "Test send failed")
    return {"success": True, "message_sid": res.get("message_sid")}


@router.post("/campaigns", response_model=CampaignResponse)
async def create_campaign(
    request: CampaignBodyRequest,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    dealership_id = _company_id(current_user)
    if not request.save_as_draft:
        await _require_promo_enabled(db, dealership_id)
    bad = sms_consent.disallowed_link_hosts(request.body)
    if bad:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Only links to {settings.sms_allowed_link_domains} are allowed. Remove: {', '.join(bad)}",
        )
    broadcast = await broadcasts.create_broadcast(
        db,
        dealership_id,
        current_user.id,
        request.body,
        name=request.name,
        media_urls=request.media_urls,
        filters=request.filters.model_dump(exclude_none=True),
        save_as_draft=request.save_as_draft,
        scheduled_at=request.scheduled_at,
    )
    await db.commit()
    return _campaign_response(broadcast, {current_user.id: current_user.full_name})


@router.patch("/campaigns/{campaign_id}", response_model=CampaignResponse)
async def update_draft_campaign(
    campaign_id: UUID,
    request: CampaignBodyRequest,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    dealership_id = _company_id(current_user)
    broadcast = await db.get(SMSBroadcast, campaign_id)
    if broadcast is None or broadcast.dealership_id != dealership_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campaign not found")
    if broadcast.status != "draft":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only saved drafts can be edited")
    bad = sms_consent.disallowed_link_hosts(request.body)
    if bad:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Only links to {settings.sms_allowed_link_domains} are allowed. Remove: {', '.join(bad)}",
        )
    broadcast.name = (request.name or "").strip()[:160] or None
    broadcast.body = broadcasts.build_body(request.body)
    broadcast.media_urls = list(request.media_urls or [])
    broadcast.filters = request.filters.model_dump(exclude_none=True)
    broadcast.scheduled_at = request.scheduled_at
    broadcast.total_recipients = await broadcasts.audience_count(db, dealership_id, broadcast.filters)
    await db.commit()
    return _campaign_response(broadcast, {current_user.id: current_user.full_name})


@router.post("/campaigns/{campaign_id}/launch", response_model=CampaignResponse)
async def launch_campaign(
    campaign_id: UUID,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    dealership_id = _company_id(current_user)
    await _require_promo_enabled(db, dealership_id)
    broadcast = await db.get(SMSBroadcast, campaign_id)
    if broadcast is None or broadcast.dealership_id != dealership_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campaign not found")
    if broadcast.status != "draft":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Campaign is not a draft")
    await broadcasts.launch_draft_broadcast(db, broadcast)
    await db.commit()
    return _campaign_response(broadcast, {current_user.id: current_user.full_name})


@router.delete("/campaigns/{campaign_id}")
async def delete_campaign(
    campaign_id: UUID,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    dealership_id = _company_id(current_user)
    broadcast = await db.get(SMSBroadcast, campaign_id)
    if broadcast is None or broadcast.dealership_id != dealership_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campaign not found")
    if broadcast.status not in ("draft", "cancelled"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only saved drafts or cancelled campaigns can be deleted",
        )
    await db.delete(broadcast)
    await db.commit()
    return {"status": "deleted"}


@router.get("/campaigns", response_model=List[CampaignResponse])
async def list_campaigns(
    limit: int = Query(50, ge=1, le=100),
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    dealership_id = _company_id(current_user)
    rows = (
        await db.execute(
            select(SMSBroadcast)
            .where(SMSBroadcast.dealership_id == dealership_id)
            .order_by(SMSBroadcast.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    creator_ids = {b.created_by for b in rows if b.created_by}
    names = {}
    if creator_ids:
        users = (await db.execute(select(User).where(User.id.in_(creator_ids)))).scalars().all()
        names = {u.id: u.full_name for u in users}
    delivery = await broadcasts.delivery_breakdown(db, [b.id for b in rows])
    return [_campaign_response(b, names, delivery.get(b.id)) for b in rows]


@router.post("/campaigns/{campaign_id}/cancel", response_model=CampaignResponse)
async def cancel_campaign(
    campaign_id: UUID,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    dealership_id = _company_id(current_user)
    broadcast = await db.get(SMSBroadcast, campaign_id)
    if broadcast is None or broadcast.dealership_id != dealership_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campaign not found")
    await broadcasts.cancel_broadcast(db, broadcast)
    await db.commit()
    return _campaign_response(broadcast, {})
