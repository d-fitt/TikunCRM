"""
SMS API Endpoints - Conversation-style messaging
"""
import logging
from datetime import datetime
from typing import Optional, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api import deps
from app.services.dealership_twilio_config_service import get_effective_twilio_config
from app.core.permissions import UserRole
from app.core.access_scope import get_accessible_dealership_ids, user_can_access_lead
from app.db.database import get_db
from app.models.user import User
from app.models.sms_log import SMSLog, MessageDirection
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
    """Request to send SMS"""
    to_number: str = Field(..., description="Phone number to send to")
    body: str = Field(..., min_length=1, max_length=1600, description="Message body")
    lead_id: Optional[UUID] = Field(None, description="Optional lead ID")


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
    consent: Optional[SMSConsentStatus] = None


class ConversationListItem(BaseModel):
    """Conversation list item"""
    lead_id: str
    lead_name: str
    lead_phone: Optional[str]
    last_message: dict
    unread_count: int


class ConversationsListResponse(BaseModel):
    """List of conversations"""
    items: List[ConversationListItem]
    total_unread: int


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


@router.get("/conversations", response_model=ConversationsListResponse)
async def list_conversations(
    unread_only: bool = Query(False),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db)
):
    """List SMS conversations"""
    service = get_sms_conversation_service(db)
    
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

    conversations = await service.get_conversations_list(
        user_id=user_id,
        dealership_id=dealership_id,
        dealership_ids=dealership_ids,
        unread_only=unread_only,
        limit=limit,
        offset=offset
    )

    total_unread = await service.get_unread_count(
        user_id=user_id,
        dealership_id=dealership_id,
        dealership_ids=dealership_ids,
    )
    
    return ConversationsListResponse(
        items=[ConversationListItem(**c) for c in conversations],
        total_unread=total_unread
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
    
    # Mark as read
    await service.mark_conversation_as_read(lead_id)
    await db.commit()
    
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
            )
            for msg in messages
        ]
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

    service = get_sms_conversation_service(db)

    success, sms_log, error = await service.send_sms(
        to_number=lead.phone,
        body=request.body,
        user_id=current_user.id,
        lead_id=lead.id,
        dealership_id=lead.dealership_id
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
    
    return {"status": "ok"}


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

class CampaignBodyRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=1000)


class CampaignPreviewResponse(BaseModel):
    final_body: str
    sample: str
    segments: int
    characters: int
    blocked_links: List[str]
    audience: int


class CampaignResponse(BaseModel):
    id: UUID
    body: str
    status: str
    total_recipients: int
    sent_count: int
    failed_count: int
    skipped_count: int
    created_at: datetime
    completed_at: Optional[datetime]
    created_by_name: Optional[str] = None


class CampaignOverviewResponse(BaseModel):
    promo_enabled: bool
    audience: int
    in_send_window: bool
    send_window: str
    timezone: str


def _campaign_response(b: SMSBroadcast, names: dict) -> CampaignResponse:
    return CampaignResponse(
        id=b.id,
        body=b.body,
        status=b.status,
        total_recipients=b.total_recipients,
        sent_count=b.sent_count,
        failed_count=b.failed_count,
        skipped_count=b.skipped_count,
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


@router.post("/campaigns/preview", response_model=CampaignPreviewResponse)
async def preview_campaign(
    request: CampaignBodyRequest,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    dealership_id = _company_id(current_user)
    return CampaignPreviewResponse(
        **broadcasts.preview(request.body),
        audience=await broadcasts.audience_count(db, dealership_id),
    )


@router.post("/campaigns", response_model=CampaignResponse)
async def create_campaign(
    request: CampaignBodyRequest,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    dealership_id = _company_id(current_user)
    await _require_promo_enabled(db, dealership_id)
    bad = sms_consent.disallowed_link_hosts(request.body)
    if bad:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Only links to {settings.sms_allowed_link_domains} are allowed. Remove: {', '.join(bad)}",
        )
    broadcast = await broadcasts.create_broadcast(db, dealership_id, current_user.id, request.body)
    await db.commit()
    return _campaign_response(broadcast, {current_user.id: current_user.full_name})


@router.get("/campaigns", response_model=List[CampaignResponse])
async def list_campaigns(
    limit: int = Query(30, ge=1, le=100),
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
    return [_campaign_response(b, names) for b in rows]


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
