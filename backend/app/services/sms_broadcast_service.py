"""
Promotional SMS/MMS campaigns with advanced audience filtering, drafts/templates,
scheduling, media attachments, and batched sending.

Recipients are snapshotted when a campaign is launched (only customers with
promotional consent), then a scheduler job sends a small batch every minute
inside the allowed hours. Consent is re-checked right before every send.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import String, and_, cast, exists, func, not_, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissions import UserRole
from app.core.timezone import utc_now
from app.models.campaign_mapping import CampaignMapping
from app.models.customer import Customer
from app.models.customer_stip_document import CustomerStipDocument
from app.models.dealership import Dealership
from app.models.lead import Lead
from app.models.lead_stage import LeadStage
from app.models.lead_stip_document import LeadStipDocument
from app.models.sms_broadcast import SMSBroadcast, SMSBroadcastRecipient
from app.models.sms_log import MessageDirection, SMSLog
from app.models.user import User
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


def _parse_date(val: Any, end_of_day: bool = False) -> Optional[datetime]:
    if not val:
        return None
    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=timezone.utc)
    try:
        d = date.fromisoformat(str(val)[:10])
        t = time(23, 59, 59, 999999) if end_of_day else time(0, 0, 0)
        return datetime.combine(d, t, tzinfo=timezone.utc)
    except ValueError:
        return None


def _lead_has_stips_expr():
    return or_(
        Lead.has_ssn_stip.is_(True),
        Lead.has_dl_stip.is_(True),
        exists().where(LeadStipDocument.lead_id == Lead.id),
        exists().where(CustomerStipDocument.customer_id == Lead.customer_id),
    )


def _lead_filter_conditions(dealership_id: UUID, filters: Optional[Dict[str, Any]] = None) -> list:
    f = filters or {}
    conds = [Lead.dealership_id == dealership_id]

    if f.get("only_active"):
        conds.append(Lead.is_active.is_(True))

    stage_ids_raw = f.get("stage_ids") or []
    stage_ids = []
    for sid in stage_ids_raw:
        try:
            stage_ids.append(UUID(str(sid)))
        except ValueError:
            pass
    if stage_ids:
        conds.append(Lead.stage_id.in_(stage_ids))

    campaigns = [str(c).strip() for c in (f.get("campaigns") or []) if str(c).strip()]
    if campaigns:
        conds.append(
            or_(
                Lead.source_campaign_raw.in_(campaigns),
                Lead.meta_data["campaign_name"].astext.in_(campaigns),
                Lead.meta_data["source_display"].astext.in_(campaigns),
                exists().where(
                    and_(
                        CampaignMapping.id == Lead.campaign_mapping_id,
                        CampaignMapping.display_name.in_(campaigns),
                    )
                ),
            )
        )

    sources = [str(s).strip().lower() for s in (f.get("sources") or []) if str(s).strip()]
    if sources:
        conds.append(func.lower(cast(Lead.source, String)).in_(sources))

    dt_from = _parse_date(f.get("date_from"), end_of_day=False)
    if dt_from:
        conds.append(Lead.created_at >= dt_from)
    dt_to = _parse_date(f.get("date_to"), end_of_day=True)
    if dt_to:
        conds.append(Lead.created_at <= dt_to)

    has_stips = f.get("has_stips")
    if has_stips is True:
        conds.append(_lead_has_stips_expr())
    elif has_stips is False:
        conds.append(not_(_lead_has_stips_expr()))

    assigned_to = f.get("assigned_to")
    if assigned_to == "unassigned":
        conds.append(and_(Lead.assigned_to.is_(None), Lead.bdc_assigned_to_id.is_(None)))
    elif assigned_to == "assigned":
        conds.append(or_(Lead.assigned_to.isnot(None), Lead.bdc_assigned_to_id.isnot(None)))
    elif assigned_to:
        try:
            uid = UUID(str(assigned_to))
            conds.append(or_(Lead.assigned_to == uid, Lead.bdc_assigned_to_id == uid))
        except ValueError:
            pass

    min_dp = f.get("min_down_payment")
    if min_dp is not None and str(min_dp).strip() != "":
        try:
            conds.append(Lead.down_payment >= Decimal(str(min_dp)))
        except Exception:
            pass

    search = (f.get("search") or "").strip()
    if search:
        term = f"%{search}%"
        full_name = func.concat_ws(" ", Customer.first_name, Customer.last_name)
        search_conds = [
            full_name.ilike(term),
            Lead.interested_in.ilike(term),
            Lead.source_campaign_raw.ilike(term),
        ]
        digits = "".join(ch for ch in search if ch.isdigit())
        if len(digits) >= 3:
            search_conds.append(func.regexp_replace(Customer.phone, r"\D", "", "g").like(f"%{digits}%"))
        conds.append(or_(*search_conds))

    return conds


def _audience_filter(dealership_id: UUID, filters: Optional[Dict[str, Any]] = None):
    f = filters or {}
    lead_conds = _lead_filter_conditions(dealership_id, f)
    cust_conds = [
        Customer.sms_promo_consent.is_(True),
        Customer.sms_opted_out.is_(False),
        Customer.phone.isnot(None),
        Customer.phone != "",
        exists().where(and_(Lead.customer_id == Customer.id, *lead_conds)),
    ]

    exclude_days = f.get("exclude_contacted_in_days")
    if exclude_days is not None and str(exclude_days).strip() != "":
        try:
            days = int(exclude_days)
            if days > 0:
                cutoff = utc_now() - timedelta(days=days)
                cust_conds.append(
                    not_(
                        exists().where(
                            and_(
                                SMSLog.customer_id == Customer.id,
                                SMSLog.direction == MessageDirection.OUTBOUND,
                                SMSLog.category == sms_consent.CATEGORY_PROMOTIONAL,
                                SMSLog.created_at >= cutoff,
                            )
                        )
                    )
                )
        except ValueError:
            pass

    return and_(*cust_conds)


async def audience_count(
    db: AsyncSession, dealership_id: UUID, filters: Optional[Dict[str, Any]] = None
) -> int:
    return (
        await db.execute(select(func.count(Customer.id)).where(_audience_filter(dealership_id, filters)))
    ).scalar_one()


async def audience_preview(
    db: AsyncSession,
    dealership_id: UUID,
    filters: Optional[Dict[str, Any]] = None,
    limit: int = 30,
) -> Dict[str, Any]:
    """Return total matching opted-in customers + sample lead rows for visual verification."""
    total = await audience_count(db, dealership_id, filters)
    if total == 0:
        return {"total": 0, "sample_leads": []}

    lead_conds = _lead_filter_conditions(dealership_id, filters)
    latest_lead_id = (
        select(Lead.id)
        .where(Lead.customer_id == Customer.id, *lead_conds)
        .order_by(Lead.created_at.desc())
        .limit(1)
        .correlate(Customer)
        .scalar_subquery()
    )

    cust_rows = (
        await db.execute(
            select(Customer.id, latest_lead_id)
            .where(_audience_filter(dealership_id, filters))
            .order_by(Customer.created_at.desc())
            .limit(limit)
        )
    ).all()

    lead_ids = [lid for _, lid in cust_rows if lid is not None]
    if not lead_ids:
        return {"total": total, "sample_leads": []}

    has_stips_col = _lead_has_stips_expr().label("has_stips")
    rows = (
        await db.execute(
            select(
                Lead.id,
                Lead.customer_id,
                Customer.first_name,
                Customer.last_name,
                Customer.phone,
                LeadStage.display_name,
                LeadStage.color,
                Lead.source_campaign_raw,
                CampaignMapping.display_name.label("mapped_campaign"),
                Lead.meta_data,
                Lead.source,
                Lead.interested_in,
                Lead.down_payment,
                Lead.created_at,
                has_stips_col,
            )
            .join(Customer, Lead.customer_id == Customer.id)
            .outerjoin(LeadStage, Lead.stage_id == LeadStage.id)
            .outerjoin(CampaignMapping, Lead.campaign_mapping_id == CampaignMapping.id)
            .where(Lead.id.in_(lead_ids))
            .order_by(Lead.created_at.desc())
        )
    ).all()

    sample_leads = []
    for r in rows:
        meta = r.meta_data or {}
        campaign = r.mapped_campaign or r.source_campaign_raw or meta.get("source_display") or meta.get("campaign_name")
        sample_leads.append(
            {
                "lead_id": str(r.id),
                "customer_id": str(r.customer_id),
                "name": f"{r.first_name or ''} {r.last_name or ''}".strip() or "Unknown",
                "phone": r.phone,
                "stage_name": r.display_name,
                "stage_color": r.color,
                "campaign": campaign,
                "source": r.source.value if hasattr(r.source, "value") else str(r.source),
                "interested_in": r.interested_in,
                "down_payment": float(r.down_payment) if r.down_payment is not None else None,
                "has_stips": bool(r.has_stips),
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
        )

    return {"total": total, "sample_leads": sample_leads}


async def get_filter_options(db: AsyncSession, dealership_id: UUID) -> Dict[str, Any]:
    """Return available stages, campaigns, sources, and active agents for the filter builder."""
    stages_rows = (
        await db.execute(
            select(LeadStage.id, LeadStage.display_name, LeadStage.color, LeadStage.order)
            .where(or_(LeadStage.dealership_id == dealership_id, LeadStage.dealership_id.is_(None)))
            .order_by(LeadStage.order.asc())
        )
    ).all()
    stages = [
        {"id": str(r.id), "name": r.display_name, "color": r.color}
        for r in stages_rows
    ]

    campaign_expr = func.coalesce(
        CampaignMapping.display_name,
        Lead.source_campaign_raw,
        Lead.meta_data["source_display"].astext,
        Lead.meta_data["campaign_name"].astext,
    )
    campaign_rows = (
        await db.execute(
            select(campaign_expr.label("cname"), func.count(func.distinct(Lead.customer_id)).label("cnt"))
            .outerjoin(CampaignMapping, Lead.campaign_mapping_id == CampaignMapping.id)
            .where(Lead.dealership_id == dealership_id, campaign_expr.isnot(None), campaign_expr != "")
            .group_by("cname")
            .order_by(func.count(func.distinct(Lead.customer_id)).desc())
            .limit(80)
        )
    ).all()
    campaigns = [{"name": r.cname, "count": int(r.cnt)} for r in campaign_rows if r.cname]

    source_rows = (
        await db.execute(
            select(cast(Lead.source, String).label("src"), func.count(func.distinct(Lead.customer_id)).label("cnt"))
            .where(Lead.dealership_id == dealership_id)
            .group_by("src")
            .order_by(func.count(func.distinct(Lead.customer_id)).desc())
        )
    ).all()
    sources = [{"value": str(r.src).lower(), "count": int(r.cnt)} for r in source_rows if r.src]

    agent_rows = (
        await db.execute(
            select(User.id, User.first_name, User.last_name, User.role)
            .where(
                User.dealership_id == dealership_id,
                User.is_active.is_(True),
                User.role.in_([UserRole.BDC, UserRole.DEALERSHIP_ADMIN, UserRole.SUPER_ADMIN]),
            )
            .order_by(User.first_name.asc())
        )
    ).all()
    agents = [
        {"id": str(r.id), "name": f"{r.first_name or ''} {r.last_name or ''}".strip()}
        for r in agent_rows
    ]

    return {
        "stages": stages,
        "campaigns": campaigns,
        "sources": sources,
        "agents": agents,
    }


def build_body(raw_body: str) -> str:
    return sms_consent.prepare_promotional_body(raw_body)


def preview(
    raw_body: str,
    sample_first_name: str = "María",
    media_urls: Optional[List[str]] = None,
) -> dict:
    body = build_body(raw_body)
    sample = sms_consent.personalize(
        body,
        sample_first_name,
        last_name="García",
        vehicle="2022 Toyota RAV4",
        down_payment=2000,
        agent_name="Carlos",
        dealership_name=sms_consent.brand(),
        dealership_phone="(404) 555-0199",
        dealership_address="123 Main St, Atlanta, GA",
    )
    has_media = bool(media_urls)
    return {
        "final_body": body,
        "sample": sample,
        "segments": 1 if has_media else sms_consent.segment_count(sample),
        "characters": len(sample),
        "blocked_links": sms_consent.disallowed_link_hosts(body),
        "is_mms": has_media,
    }


async def _populate_recipients(db: AsyncSession, broadcast: SMSBroadcast) -> int:
    filters = broadcast.filters or {}
    lead_conds = _lead_filter_conditions(broadcast.dealership_id, filters)
    latest_lead = (
        select(Lead.id)
        .where(Lead.customer_id == Customer.id, *lead_conds)
        .order_by(Lead.created_at.desc())
        .limit(1)
        .correlate(Customer)
        .scalar_subquery()
    )
    rows = (
        await db.execute(
            select(Customer.id, latest_lead).where(_audience_filter(broadcast.dealership_id, filters))
        )
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
    return len(rows)


async def create_broadcast(
    db: AsyncSession,
    dealership_id: UUID,
    created_by: UUID,
    raw_body: str,
    *,
    name: Optional[str] = None,
    media_urls: Optional[List[str]] = None,
    filters: Optional[Dict[str, Any]] = None,
    save_as_draft: bool = False,
    scheduled_at: Optional[datetime] = None,
) -> SMSBroadcast:
    body = build_body(raw_body)
    broadcast = SMSBroadcast(
        dealership_id=dealership_id,
        created_by=created_by,
        name=(name or "").strip()[:160] or None,
        body=body,
        media_urls=list(media_urls or []),
        filters=dict(filters or {}),
        status="draft" if save_as_draft else "queued",
        scheduled_at=scheduled_at,
    )
    db.add(broadcast)
    await db.flush()

    if save_as_draft:
        broadcast.total_recipients = await audience_count(db, dealership_id, broadcast.filters)
        await db.flush()
        return broadcast

    await _populate_recipients(db, broadcast)
    return broadcast


async def launch_draft_broadcast(db: AsyncSession, broadcast: SMSBroadcast) -> SMSBroadcast:
    if broadcast.status != "draft":
        return broadcast
    broadcast.status = "queued"
    broadcast.completed_at = None
    broadcast.sent_count = 0
    broadcast.failed_count = 0
    broadcast.skipped_count = 0
    await _populate_recipients(db, broadcast)
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

    lead = await db.get(Lead, recipient.lead_id) if recipient.lead_id else None
    agent = await db.get(User, lead.assigned_to) if (lead and lead.assigned_to) else None
    dealership = await db.get(Dealership, broadcast.dealership_id) if broadcast.dealership_id else None
    store_address = None
    if dealership:
        parts = [p for p in (dealership.address, dealership.city, dealership.state) if p]
        store_address = ", ".join(parts) if parts else None

    personalized_body = sms_consent.personalize(
        broadcast.body,
        customer.first_name,
        last_name=customer.last_name,
        vehicle=lead.interested_in if lead else None,
        down_payment=lead.down_payment if lead else None,
        agent_name=agent.full_name if agent else None,
        dealership_name=dealership.name if dealership else None,
        dealership_phone=dealership.phone if dealership else None,
        dealership_address=store_address,
    )

    service = SMSConversationService(db)
    ok, sms_log, error = await service.send_sms(
        to_number=customer.phone,
        body=personalized_body,
        user_id=broadcast.created_by,
        lead_id=recipient.lead_id,
        dealership_id=broadcast.dealership_id,
        category=sms_consent.CATEGORY_PROMOTIONAL,
        media_urls=list(broadcast.media_urls or []) or None,
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
    if broadcast.scheduled_at and utc_now() < broadcast.scheduled_at:
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
