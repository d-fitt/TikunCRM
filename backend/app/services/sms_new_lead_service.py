"""
First text to a new form lead, plus the one-time promotional opt-in confirmation
required by the A2P campaign.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.core.timezone import utc_now
from app.models.customer import Customer
from app.models.lead import Lead
from app.models.sms_log import MessageDirection, SMSLog
from app.services import sms_consent_service as sms_consent
from app.services.dealership_twilio_config_service import get_effective_twilio_config
from app.services.sms_conversation_service import SMSConversationService

logger = logging.getLogger(__name__)

MAX_LEAD_AGE = timedelta(hours=24)
REPEAT_GUARD = timedelta(days=7)
SENT_FLAG = "sms_auto_first_sent_at"


async def _recent_auto_first(db: AsyncSession, customer_id: UUID) -> bool:
    since = utc_now() - REPEAT_GUARD
    found = await db.execute(
        select(SMSLog.id)
        .where(
            SMSLog.customer_id == customer_id,
            SMSLog.direction == MessageDirection.OUTBOUND,
            SMSLog.category == sms_consent.CATEGORY_AUTO_FIRST,
            SMSLog.created_at >= since,
        )
        .limit(1)
    )
    return found.scalar_one_or_none() is not None


async def send_new_lead_texts(db: AsyncSession, lead_id: UUID) -> None:
    try:
        await _send_new_lead_texts(db, lead_id)
    except Exception:
        await db.rollback()
        raise


async def _send_new_lead_texts(db: AsyncSession, lead_id: UUID) -> None:
    lead = await db.get(Lead, lead_id)
    if lead is None or not lead.customer_id:
        return
    effective = await get_effective_twilio_config(db, lead.dealership_id)
    if not effective.is_sms_ready() or not effective.sms_auto_first_message_enabled:
        logger.info(
            "New-lead text skipped for lead %s: sms ready=%s auto-text=%s",
            lead_id,
            effective.is_sms_ready(),
            effective.sms_auto_first_message_enabled,
        )
        return
    meta = dict(lead.meta_data or {})
    if meta.get(SENT_FLAG):
        return
    if lead.created_at and utc_now() - lead.created_at > MAX_LEAD_AGE:
        return

    customer = await db.get(Customer, lead.customer_id)
    if customer is None or not customer.phone:
        return

    inquiry, promo, source = sms_consent.consent_from_columns(meta.get("sms_consent_columns"))
    sms_consent.record_form_consent(customer, inquiry, promo, source)
    meta[SENT_FLAG] = utc_now().isoformat()
    lead.meta_data = meta
    flag_modified(lead, "meta_data")
    await db.commit()

    if customer.sms_opted_out or await _recent_auto_first(db, customer.id):
        return

    service = SMSConversationService(db)
    vehicle = lead.interested_in or (lead.meta_data or {}).get("vehicle")
    ok, _, error = await service.send_sms(
        to_number=customer.phone,
        body=sms_consent.auto_first_message(customer.first_name, vehicle),
        user_id=None,
        lead_id=lead.id,
        dealership_id=lead.dealership_id,
        category=sms_consent.CATEGORY_AUTO_FIRST,
    )
    if not ok:
        logger.info("New-lead text not sent for lead %s: %s", lead.id, error)
        await db.commit()
        return

    if customer.sms_promo_consent and not customer.sms_promo_confirmed_at:
        ok, _, error = await service.send_sms(
            to_number=customer.phone,
            body=sms_consent.promo_confirmation_message(),
            user_id=None,
            lead_id=lead.id,
            dealership_id=lead.dealership_id,
            category=sms_consent.CATEGORY_COMPLIANCE,
        )
        if ok:
            customer.sms_promo_confirmed_at = utc_now()
        else:
            logger.info("Promo confirmation not sent for lead %s: %s", lead.id, error)
    await db.commit()
