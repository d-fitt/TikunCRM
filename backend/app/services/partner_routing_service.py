"""Helpers for a lead that a person has already sent to a partner store.

Choosing the store happens in partner_send_service. This module does not pick one.
"""
import logging
from datetime import datetime
from typing import Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.timezone import utc_now
from app.models.customer import Customer
from app.models.lead import Lead
from app.models.lead_delivery import (
    DELIVERY_APPOINTMENT_SET,
    LOCKING_STATUSES,
    LeadDelivery,
)
from app.models.partner_program import PROGRAM_FULL_BDC
from app.models.partner_store import PartnerStore

logger = logging.getLogger(__name__)


def brand_key(value: Optional[str]) -> str:
    return (value or "").strip().casefold()


async def mark_delivery_appointment_set(
    db: AsyncSession,
    lead_id: UUID,
    partner_store_id: UUID,
    scheduled_at: datetime,
) -> Optional[LeadDelivery]:
    """Move an existing full-BDC delivery to appointment set and email the store once."""
    delivery = (
        await db.execute(
            select(LeadDelivery).where(
                LeadDelivery.lead_id == lead_id,
                LeadDelivery.partner_store_id == partner_store_id,
                LeadDelivery.program_type == PROGRAM_FULL_BDC,
                LeadDelivery.status.in_(LOCKING_STATUSES),
            )
        )
    ).scalar_one_or_none()
    if delivery is None:
        return None
    already = delivery.status == DELIVERY_APPOINTMENT_SET
    delivery.status = DELIVERY_APPOINTMENT_SET
    delivery.updated_at = utc_now()
    await db.flush()
    if not already:
        store = await db.get(PartnerStore, partner_store_id)
        lead = await db.get(Lead, lead_id)
        customer = await db.get(Customer, lead.customer_id) if lead else None
        when = scheduled_at.isoformat()
        name = _customer_name(customer) if customer else "A customer"
        if store is not None:
            await _email_store(
                store,
                subject=f"Appointment set at {store.name}",
                message=f"{name} is booked for {when}.",
            )
    return delivery


async def return_delivery(db: AsyncSession, delivery: LeadDelivery, note: Optional[str]) -> None:
    delivery.status = "returned"
    if note:
        delivery.note = note
    delivery.updated_at = utc_now()
    await db.flush()


async def _email_store(store: PartnerStore, subject: str, message: str) -> None:
    if not store.email:
        return
    try:
        from app.services.email_notifier import email_notifier

        await email_notifier.send_notification_email(
            to_email=store.email,
            to_name=store.contact_person or store.name,
            subject=subject,
            message=message,
            link="/partner",
        )
    except Exception:
        logger.exception("Partner email failed for store %s", store.id)


def _customer_name(customer: Optional[Customer]) -> str:
    if customer is None:
        return "A customer"
    name = f"{customer.first_name or ''} {customer.last_name or ''}".strip()
    return name or "A customer"
