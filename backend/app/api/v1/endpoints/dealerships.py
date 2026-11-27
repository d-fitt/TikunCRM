"""
Company settings endpoints (the single Carvaminos record in the dealerships table).
"""
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import deps
from app.core.permissions import UserRole
from app.db.database import get_db
from app.models.dealership import Dealership
from app.models.user import User
from app.schemas.dealership import DealershipResponse, DealershipUpdate
from app.schemas.dealership_twilio_config import (
    DealershipTwilioConfigResponse,
    DealershipTwilioConfigUpdate,
)
from app.models.dealership_twilio_config import DealershipTwilioConfig
from app.services.dealership_twilio_config_service import get_dealership_twilio_row
router = APIRouter()


def _ensure_can_manage_dealership_twilio(current_user: User, dealership_id: UUID) -> None:
    """Super Admins any dealership; owners/admins only their own."""
    if current_user.role == UserRole.SUPER_ADMIN:
        return
    if current_user.dealership_id != dealership_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authorized to manage Twilio for this dealership",
        )
    if current_user.role != UserRole.DEALERSHIP_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins and managers can manage Twilio settings",
        )


@router.get("/{dealership_id}", response_model=DealershipResponse)
async def get_dealership(
    dealership_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user)
) -> Any:
    """
    Get dealership by ID.
    """
    from app.core.access_scope import user_can_access_dealership

    if not await user_can_access_dealership(db, current_user, dealership_id):
        raise HTTPException(status_code=403, detail="Not authorized to view another dealership")

    result = await db.execute(select(Dealership).where(Dealership.id == dealership_id))
    dealership = result.scalar_one_or_none()
    
    if not dealership:
        raise HTTPException(status_code=404, detail="Dealership not found")
        
    return dealership


@router.put("/{dealership_id}", response_model=DealershipResponse)
async def update_dealership(
    dealership_id: UUID,
    dealership_in: DealershipUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user)
) -> Any:
    """
    Update dealership settings.
    Dealership Owner/Admin can update their own dealership.
    Super Admin can update any dealership.
    """
    result = await db.execute(select(Dealership).where(Dealership.id == dealership_id))
    dealership = result.scalar_one_or_none()
    
    if not dealership:
        raise HTTPException(status_code=404, detail="Dealership not found")
    
    # Permission checks
    if current_user.role != UserRole.SUPER_ADMIN:
        if current_user.dealership_id != dealership_id:
            raise HTTPException(status_code=403, detail="Not authorized to update another dealership")
        if current_user.role != UserRole.DEALERSHIP_ADMIN:
            raise HTTPException(status_code=403, detail="Only admins and managers can update settings")
    
    # Update fields
    update_data = dealership_in.model_dump(exclude_unset=True, exclude={"config", "working_hours", "lead_assignment_rules", "is_active"})
    
    for field, value in update_data.items():
        setattr(dealership, field, value)
    
    # Update nested objects if provided
    if dealership_in.config is not None:
        dealership.config = dealership_in.config
    
    if dealership_in.working_hours is not None:
        dealership.working_hours = {k: v.model_dump() if hasattr(v, 'model_dump') else v for k, v in dealership_in.working_hours.items()}
    
    if dealership_in.lead_assignment_rules is not None:
        dealership.lead_assignment_rules = dealership_in.lead_assignment_rules.model_dump()
    
    await db.flush()
    await db.commit()
    await db.refresh(dealership)
    return dealership


@router.patch("/{dealership_id}", response_model=DealershipResponse)
async def patch_dealership(
    dealership_id: UUID,
    dealership_in: DealershipUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user)
) -> Any:
    """
    Partially update dealership settings (same as PUT but explicit PATCH).
    Dealership Owner/Admin can update their own dealership.
    Super Admin can update any dealership.
    """
    result = await db.execute(select(Dealership).where(Dealership.id == dealership_id))
    dealership = result.scalar_one_or_none()
    
    if not dealership:
        raise HTTPException(status_code=404, detail="Dealership not found")
    
    # Permission checks
    if current_user.role != UserRole.SUPER_ADMIN:
        if current_user.dealership_id != dealership_id:
            raise HTTPException(status_code=403, detail="Not authorized to update another dealership")
        if current_user.role != UserRole.DEALERSHIP_ADMIN:
            raise HTTPException(status_code=403, detail="Only admins and managers can update settings")
    
    # Update only provided fields
    update_data = dealership_in.model_dump(exclude_unset=True, exclude={"config", "working_hours", "lead_assignment_rules", "is_active"})
    
    for field, value in update_data.items():
        setattr(dealership, field, value)
    
    # Update nested objects if provided
    if dealership_in.config is not None:
        dealership.config = dealership_in.config
    
    if dealership_in.working_hours is not None:
        dealership.working_hours = {k: v.model_dump() if hasattr(v, 'model_dump') else v for k, v in dealership_in.working_hours.items()}
    
    if dealership_in.lead_assignment_rules is not None:
        dealership.lead_assignment_rules = dealership_in.lead_assignment_rules.model_dump()
    
    await db.flush()
    await db.commit()
    await db.refresh(dealership)
    return dealership


def _twilio_config_to_response(
    dealership_id: UUID, row: Optional[DealershipTwilioConfig]
) -> DealershipTwilioConfigResponse:
    if not row:
        return DealershipTwilioConfigResponse(
            dealership_id=dealership_id,
            auth_token_set=False,
            api_key_secret_set=False,
        )
    auth_plain = row.auth_token
    sec_plain = row.twilio_api_key_secret
    return DealershipTwilioConfigResponse(
        dealership_id=dealership_id,
        account_sid=row.account_sid,
        auth_token_set=bool(auth_plain),
        auth_token=auth_plain or None,
        sms_enabled=row.sms_enabled,
        sms_from_number=row.sms_from_number,
        whatsapp_enabled=row.whatsapp_enabled,
        whatsapp_from_number=row.whatsapp_from_number,
        voice_enabled=row.voice_enabled,
        twilio_twiml_app_sid=row.twilio_twiml_app_sid,
        twilio_api_key_sid=row.twilio_api_key_sid,
        api_key_secret_set=bool(sec_plain),
        twilio_api_key_secret=sec_plain or None,
        voice_caller_id_number=row.voice_caller_id_number,
        ai_outbound_enabled=row.ai_outbound_enabled,
        messaging_service_sid=row.messaging_service_sid,
        sms_auto_first_message_enabled=row.sms_auto_first_message_enabled,
        sms_promo_enabled=row.sms_promo_enabled,
    )


@router.get(
    "/{dealership_id}/twilio-config",
    response_model=DealershipTwilioConfigResponse,
)
async def get_dealership_twilio_config(
    dealership_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.require_config_unlock),
) -> Any:
    """Read per-dealership Twilio settings. Decrypted auth token and API key secret are included after config unlock."""
    _ensure_can_manage_dealership_twilio(current_user, dealership_id)
    result = await db.execute(select(Dealership).where(Dealership.id == dealership_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Dealership not found")
    row = await get_dealership_twilio_row(db, dealership_id)
    return _twilio_config_to_response(dealership_id, row)


@router.patch(
    "/{dealership_id}/twilio-config",
    response_model=DealershipTwilioConfigResponse,
)
async def patch_dealership_twilio_config(
    dealership_id: UUID,
    body: DealershipTwilioConfigUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.require_config_unlock),
) -> Any:
    """Create or update Twilio credentials (secrets stored encrypted at rest)."""
    _ensure_can_manage_dealership_twilio(current_user, dealership_id)
    result = await db.execute(select(Dealership).where(Dealership.id == dealership_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Dealership not found")

    row = await get_dealership_twilio_row(db, dealership_id)
    if not row:
        row = DealershipTwilioConfig(dealership_id=dealership_id)
        db.add(row)

    data = body.model_dump(exclude_unset=True)
    if "auth_token" in data:
        token = data.pop("auth_token")
        if token and str(token).strip():
            row.auth_token = str(token).strip()
    if "twilio_api_key_secret" in data:
        sec = data.pop("twilio_api_key_secret")
        if sec and str(sec).strip():
            row.twilio_api_key_secret = str(sec).strip()

    for key in (
        "account_sid",
        "sms_enabled",
        "sms_from_number",
        "whatsapp_enabled",
        "whatsapp_from_number",
        "voice_enabled",
        "twilio_twiml_app_sid",
        "twilio_api_key_sid",
        "voice_caller_id_number",
        "ai_outbound_enabled",
        "messaging_service_sid",
        "sms_auto_first_message_enabled",
        "sms_promo_enabled",
    ):
        if key in data:
            setattr(row, key, data[key])

    row.updated_by_user_id = current_user.id
    await db.flush()
    await db.commit()
    await db.refresh(row)
    return _twilio_config_to_response(dealership_id, row)
