"""
Promotional SMS campaigns.

Recipients are fixed when the campaign is created (customers with promotional consent),
then a scheduler job sends a small batch every minute inside the allowed hours.
Consent is checked again for every recipient right before sending.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import and_, exists, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.timezone import utc_now
from app.models.customer import Customer
from app.models.dealership import Dealership
from app.models.lead import Lead
from app.models.sms_broadcast import SMSBroadcast, SMSBroadcastRecipient
from app.services import sms_consent_service as sms_consent
from app.services.dealership_twilio_config_service import get_effective_twilio_config
from app.services.sms_conversation_service import SMSConversationService

logger = logging.getLogger(__name__)

SEND_WINDOW_START_HOUR = 8
SEND_WINDOW_END_HOUR = 20
BATCH_SIZE = 60
STALE_CLAIM_MINUTES = 30
DEFAULT_TIMEZONE = "America/New_York"


async def dealership_timezone(db: AsyncSession, dealership_id: Optional[UUID]) -> ZoneInfo:
    tz_name = None
    if dealership_id:
        tz_name = (
            await db.execute(select(Dealership.timezone).where(Dealership.id == dealership_id))
        ).scalar_one_or_none()
    try:
        return ZoneInfo(tz_name or DEFAULT_TIMEZONE)
    except Exception:
        return ZoneInfo(DEFAULT_TIMEZONE)


def in_send_window(tz: ZoneInfo, now: Optional[datetime] = None) -> bool:
    local = (now or utc_now()).astimezone(tz)
    return SEND_WINDOW_START_HOUR <= local.hour < SEND_WINDOW_END_HOUR


def _audience_filter(dealership_id: UUID):
    return and_(
        Customer.sms_promo_consent.is_(True),
        Customer.sms_opted_out.is_(False),
        Customer.phone.isnot(None),
        Customer.phone != "",
        exists().where(and_(Lead.customer_id == Customer.id, Lead.dealership_id == dealership_id)),
    )


async def audience_count(db: AsyncSession, dealership_id: UUID) -> int:
    return (
        await db.execute(select(func.count(Customer.id)).where(_audience_filter(dealership_id)))
    ).scalar_one()


def build_body(raw_body: str) -> str:
    return sms_consent.prepare_promotional_body(raw_body)


def preview(raw_body: str, sample_first_name: str = "María") -> dict:
    body = build_body(raw_body)
    sample = sms_consent.personalize(body, sample_first_name)
    return {
        "final_body": body,
        "sample": sample,
        "segments": sms_consent.segment_count(sample),
        "characters": len(sample),
        "blocked_links": sms_consent.disallowed_link_hosts(body),
    }


async def create_broadcast(
    db: AsyncSession, dealership_id: UUID, created_by: UUID, raw_body: str
) -> SMSBroadcast:
    body = build_body(raw_body)
    broadcast = SMSBroadcast(
        dealership_id=dealership_id, created_by=created_by, body=body, status="queued"
    )
    db.add(broadcast)
    await db.flush()

    latest_lead = (
        select(Lead.id)
        .where(Lead.customer_id == Customer.id, Lead.dealership_id == dealership_id)
        .order_by(Lead.created_at.desc())
        .limit(1)
        .correlate(Customer)
        .scalar_subquery()
    )
    rows = (
        await db.execute(select(Customer.id, latest_lead).where(_audience_filter(dealership_id)))
    ).all()
    db.add_all(
        SMSBroadcastRecipient(broadcast_id=broadcast.id, customer_id=cid, lead_id=lid)
        for cid, lid in rows
    )
    broadcast.total_recipients = len(rows)
    if not rows:
        broadcast.status = "completed"
        broadcast.completed_at = utc_now()
    await db.flush()
    return broadcast


async def cancel_broadcast(db: AsyncSession, broadcast: SMSBroadcast) -> None:
    if broadcast.status in ("completed", "cancelled"):
        return
    await db.execute(
        update(SMSBroadcastRecipient)
        .where(
            SMSBroadcastRecipient.broadcast_id == broadcast.id,
            SMSBroadcastRecipient.status == "pending",
        )
        .values(status="skipped", error="Campaign cancelled", processed_at=utc_now())
    )
    broadcast.status = "cancelled"
    broadcast.completed_at = utc_now()
    await refresh_counts(db, broadcast)


async def refresh_counts(db: AsyncSession, broadcast: SMSBroadcast) -> int:
    """Update the sent/failed/skipped counters; returns how many are still waiting."""
    rows = (
        await db.execute(
            select(SMSBroadcastRecipient.status, func.count())
            .where(SMSBroadcastRecipient.broadcast_id == broadcast.id)
            .group_by(SMSBroadcastRecipient.status)
        )
    ).all()
    counts = dict(rows)
    broadcast.sent_count = counts.get("sent", 0)
    broadcast.failed_count = counts.get("failed", 0)
    broadcast.skipped_count = counts.get("skipped", 0)
    return counts.get("pending", 0) + counts.get("sending", 0)


async def _claim_batch(db: AsyncSession, broadcast_id: UUID) -> list[UUID]:
    """Mark a batch as in progress so a second worker can't send the same texts."""
    await db.execute(
        update(SMSBroadcastRecipient)
        .where(
            SMSBroadcastRecipient.broadcast_id == broadcast_id,
            SMSBroadcastRecipient.status == "sending",
            SMSBroadcastRecipient.processed_at < utc_now() - timedelta(minutes=STALE_CLAIM_MINUTES),
        )
        .values(status="failed", error="Sending was interrupted")
    )
    result = await db.execute(
        text(
            """
            UPDATE sms_broadcast_recipients SET status = 'sending', processed_at = now()
            WHERE id IN (
                SELECT id FROM sms_broadcast_recipients
                WHERE broadcast_id = :bid AND status = 'pending'
                ORDER BY id
                LIMIT :n
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id
            """
        ),
        {"bid": broadcast_id, "n": BATCH_SIZE},
    )
    ids = [r[0] for r in result.all()]
    await db.commit()
    return ids


async def _send_one(
    db: AsyncSession, broadcast: SMSBroadcast, recipient: SMSBroadcastRecipient
) -> None:
    customer = await db.get(Customer, recipient.customer_id)
    if customer is None or not customer.phone:
        recipient.status, recipient.error = "skipped", "No phone number"
        return
    service = SMSConversationService(db)
    ok, sms_log, error = await service.send_sms(
        to_number=customer.phone,
        body=sms_consent.personalize(broadcast.body, customer.first_name),
        user_id=broadcast.created_by,
        lead_id=recipient.lead_id,
        dealership_id=broadcast.dealership_id,
        category=sms_consent.CATEGORY_PROMOTIONAL,
    )
    recipient.sms_log_id = sms_log.id if sms_log else None
    if ok:
        recipient.status, recipient.error = "sent", None
    elif sms_log is None:
        recipient.status, recipient.error = "skipped", error
    else:
        recipient.status, recipient.error = "failed", error


async def process_broadcast(db: AsyncSession, broadcast: SMSBroadcast) -> None:
    effective = await get_effective_twilio_config(db, broadcast.dealership_id)
    if not effective.is_sms_ready() or not effective.sms_promo_enabled:
        return
    if not in_send_window(await dealership_timezone(db, broadcast.dealership_id)):
        return

    if broadcast.status == "queued":
        broadcast.status = "sending"
    broadcast_id = broadcast.id
    for recipient_id in await _claim_batch(db, broadcast_id):
        recipient = await db.get(SMSBroadcastRecipient, recipient_id)
        broadcast = await db.get(SMSBroadcast, broadcast_id)
        if broadcast is None or broadcast.status == "cancelled":
            break
        try:
            await _send_one(db, broadcast, recipient)
        except Exception as exc:
            logger.exception("Campaign text to customer %s failed", recipient.customer_id)
            await db.rollback()
            recipient = await db.get(SMSBroadcastRecipient, recipient_id)
            recipient.status, recipient.error = "failed", str(exc)[:500]
        recipient.processed_at = utc_now()
        await db.commit()

    broadcast = await db.get(SMSBroadcast, broadcast_id)
    if broadcast is None:
        return
    remaining = await refresh_counts(db, broadcast)
    if remaining == 0 and broadcast.status == "sending":
        broadcast.status = "completed"
        broadcast.completed_at = utc_now()
    await db.commit()


async def run_sms_broadcasts() -> None:
    """Scheduler entry point: send the next batch of every active campaign."""
    from app.db.database import async_session_maker

    try:
        async with async_session_maker() as db:
            ids = (
                await db.execute(
                    select(SMSBroadcast.id)
                    .where(SMSBroadcast.status.in_(("queued", "sending")))
                    .order_by(SMSBroadcast.created_at)
                )
            ).scalars().all()
            for broadcast_id in ids:
                broadcast = await db.get(SMSBroadcast, broadcast_id)
                if broadcast is not None:
                    await process_broadcast(db, broadcast)
    except Exception:
        logger.exception("SMS campaign run failed")
