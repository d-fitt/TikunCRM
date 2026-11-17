"""Staff endpoints for partner deliveries on a lead."""
from typing import Any, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import deps
from app.core.access_scope import user_can_access_lead
from app.core.permissions import Permission
from app.db.database import get_db
from app.models.lead import Lead
from app.models.lead_delivery import LeadDelivery
from app.models.partner_store import PartnerStore
from app.models.user import User
from app.services.partner_routing_service import return_delivery
from decimal import Decimal

from app.services.partner_send_service import SendDetails, SendError, send_lead_to_stores

router = APIRouter()


class DeliveryResponse(BaseModel):
    id: UUID
    lead_id: UUID
    customer_id: UUID
    brand: str
    partner_store_id: UUID
    partner_store_name: Optional[str] = None
    program_type: str
    status: str
    bdc_agent_id: Optional[UUID] = None
    note: Optional[str] = None
    sent_by_user_id: Optional[UUID] = None
    sent_by_name: Optional[str] = None
    delivered_at: Any
    updated_at: Any


class SendToStoresRequest(BaseModel):
    partner_store_ids: List[UUID] = Field(default_factory=list)
    postal_code: Optional[str] = Field(None, max_length=20)
    email: Optional[str] = Field(None, max_length=255)
    down_payment: Optional[Decimal] = None
    is_business: Optional[bool] = None
    interested_in: Optional[str] = Field(None, max_length=255)


class StoreSendResponse(BaseModel):
    partner_store_id: UUID
    partner_store_name: str
    delivery_id: UUID
    status: str
    program_type: str
    recipients: List[str] = Field(default_factory=list)
    emailed: List[str] = Field(default_factory=list)
    email_error: Optional[str] = None


class SendToStoresResponse(BaseModel):
    lead_id: UUID
    results: List[StoreSendResponse]


class ReturnDeliveryRequest(BaseModel):
    note: Optional[str] = Field(None, max_length=2000)


async def _serialize(db: AsyncSession, rows: List[LeadDelivery]) -> List[DeliveryResponse]:
    store_ids = {row.partner_store_id for row in rows}
    names = {}
    if store_ids:
        result = await db.execute(select(PartnerStore).where(PartnerStore.id.in_(store_ids)))
        names = {store.id: store.name for store in result.scalars().all()}
    user_ids = {row.sent_by_user_id for row in rows if row.sent_by_user_id}
    senders = {}
    if user_ids:
        result = await db.execute(select(User).where(User.id.in_(user_ids)))
        for person in result.scalars().all():
            senders[person.id] = f"{person.first_name} {person.last_name}".strip() or person.email
    return [
        DeliveryResponse(
            id=row.id,
            lead_id=row.lead_id,
            customer_id=row.customer_id,
            brand=row.brand,
            partner_store_id=row.partner_store_id,
            partner_store_name=names.get(row.partner_store_id),
            program_type=row.program_type,
            status=row.status,
            bdc_agent_id=row.bdc_agent_id,
            note=row.note,
            sent_by_user_id=row.sent_by_user_id,
            sent_by_name=senders.get(row.sent_by_user_id) if row.sent_by_user_id else None,
            delivered_at=row.delivered_at,
            updated_at=row.updated_at,
        )
        for row in rows
    ]


@router.get("/{lead_id}/deliveries", response_model=List[DeliveryResponse])
async def list_lead_deliveries(
    lead_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.get_current_active_user),
) -> Any:
    lead = await db.get(Lead, lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    if not await user_can_access_lead(db, current_user, lead.dealership_id, lead.assigned_to):
        raise HTTPException(status_code=403, detail="Access denied")
    rows = list(
        (
            await db.execute(
                select(LeadDelivery)
                .where(LeadDelivery.lead_id == lead_id)
                .order_by(LeadDelivery.delivered_at.desc())
            )
        ).scalars().all()
    )
    return await _serialize(db, rows)


@router.post("/{lead_id}/send-to-partner-stores", response_model=SendToStoresResponse)
async def send_lead_to_partner_stores(
    lead_id: UUID,
    body: SendToStoresRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.require_permission(Permission.CONNECT_LEAD_TO_PARTNER)),
) -> Any:
    """Admin and BDC choose one or more stores. Nothing is chosen automatically."""
    lead = await db.get(Lead, lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    if not await user_can_access_lead(db, current_user, lead.dealership_id, lead.assigned_to):
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        provided = body.model_fields_set
        results = await send_lead_to_stores(
            db,
            lead,
            body.partner_store_ids,
            current_user,
            SendDetails(
                postal_code=(body.postal_code or "") if "postal_code" in provided else None,
                email=(body.email or "") if "email" in provided else None,
                down_payment=body.down_payment if "down_payment" in provided and body.down_payment is not None else None,
                clear_down_payment="down_payment" in provided and body.down_payment is None,
                is_business=body.is_business if "is_business" in provided else None,
                clear_business="is_business" in provided and body.is_business is None,
                interested_in=(body.interested_in or "") if "interested_in" in provided else None,
            ),
        )
    except SendError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return SendToStoresResponse(
        lead_id=lead_id,
        results=[
            StoreSendResponse(
                partner_store_id=item.partner_store_id,
                partner_store_name=item.partner_store_name,
                delivery_id=item.delivery_id,
                status=item.status,
                program_type=item.program_type,
                recipients=item.recipients,
                emailed=item.emailed,
                email_error=item.email_error,
            )
            for item in results
        ],
    )


@router.post("/{lead_id}/route", response_model=List[DeliveryResponse])
async def route_lead_now(
    lead_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.require_permission(Permission.CONNECT_LEAD_TO_PARTNER)),
) -> Any:
    raise HTTPException(
        status_code=400,
        detail="Choose a partner store with Send to partner store. Leads are not assigned automatically.",
    )


@router.post("/{lead_id}/deliveries/{delivery_id}/return", response_model=List[DeliveryResponse])
async def return_lead_delivery(
    lead_id: UUID,
    delivery_id: UUID,
    body: ReturnDeliveryRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(deps.require_permission(Permission.CONNECT_LEAD_TO_PARTNER)),
) -> Any:
    lead = await db.get(Lead, lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    if not await user_can_access_lead(db, current_user, lead.dealership_id, lead.assigned_to):
        raise HTTPException(status_code=403, detail="Access denied")
    delivery = await db.get(LeadDelivery, delivery_id)
    if delivery is None or delivery.lead_id != lead_id:
        raise HTTPException(status_code=404, detail="Delivery not found")
    if delivery.status in ("dead", "returned"):
        raise HTTPException(status_code=400, detail="Delivery is already closed")
    await return_delivery(db, delivery, body.note)
    from app.models.lead_delivery import RELEASED_STATUSES

    remaining = [
        store_id
        for store_id in (
            await db.execute(
                select(LeadDelivery.partner_store_id).where(
                    LeadDelivery.lead_id == lead_id,
                    LeadDelivery.status.notin_(list(RELEASED_STATUSES)),
                )
            )
        ).scalars().all()
    ]
    if lead.partner_store_id not in remaining:
        lead.partner_store_id = remaining[-1] if remaining else None
        lead.partner_connected_at = delivery.updated_at if remaining else None
    rows = list(
        (
            await db.execute(
                select(LeadDelivery)
                .where(LeadDelivery.lead_id == lead_id)
                .order_by(LeadDelivery.delivered_at.desc())
            )
        ).scalars().all()
    )
    return await _serialize(db, rows)
