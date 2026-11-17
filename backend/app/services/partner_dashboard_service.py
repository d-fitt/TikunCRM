"""Numbers and recent sends for one partner store."""
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.customer import Customer
from app.models.lead import Lead
from app.models.lead_delivery import LeadDelivery
from app.models.partner_inventory import PartnerInventorySource, PartnerInventoryUrl
from app.models.partner_program import PartnerProgram
from app.models.partner_store import PartnerStore
from app.models.partner_store_campaign import PartnerStoreCampaign
from app.models.partner_store_channel import PartnerStoreChannel
from app.models.partner_store_recipient import PartnerStoreRecipient
from app.models.user import User
from app.models.campaign_mapping import CampaignMapping


def _month_start() -> datetime:
    zone = ZoneInfo("America/New_York")
    local = datetime.now(zone)
    return datetime(local.year, local.month, 1, tzinfo=zone).astimezone(timezone.utc)


async def active_send_counts(db: AsyncSession, store_ids: list[UUID]) -> dict[UUID, tuple[int, int]]:
    """Leads still with each store: (active now, active sent this month).

    Returned and dead deliveries are left out, so removing a lead lowers the count.
    """
    from app.models.lead_delivery import RELEASED_STATUSES

    if not store_ids:
        return {}
    start = _month_start()
    open_only = LeadDelivery.status.notin_(list(RELEASED_STATUSES))
    rows = (
        await db.execute(
            select(
                LeadDelivery.partner_store_id,
                func.count(LeadDelivery.id),
                func.count(LeadDelivery.id).filter(LeadDelivery.delivered_at >= start),
            )
            .where(LeadDelivery.partner_store_id.in_(store_ids), open_only)
            .group_by(LeadDelivery.partner_store_id)
        )
    ).all()
    counts = {store_id: (int(active), int(month)) for store_id, active, month in rows}
    return {store_id: counts.get(store_id, (0, 0)) for store_id in store_ids}


def range_position(sent: int, low: Optional[int], high: Optional[int]) -> Optional[str]:
    if low is None or high is None:
        return None
    if sent < low:
        return "below"
    if sent > high:
        return "above"
    return "in_range"


async def build_store_dashboard(db: AsyncSession, store: PartnerStore) -> dict:
    program = (
        await db.execute(
            select(PartnerProgram).where(PartnerProgram.partner_store_id == store.id)
        )
    ).scalar_one_or_none()
    recipients = [
        row.email
        for row in (
            await db.execute(
                select(PartnerStoreRecipient)
                .where(PartnerStoreRecipient.partner_store_id == store.id)
                .order_by(PartnerStoreRecipient.email)
            )
        ).scalars().all()
    ]
    campaigns = [
        {
            "campaign_mapping_id": str(mapping.id),
            "label": mapping.display_name,
            "type": "campaign",
        }
        for _link, mapping in (
            await db.execute(
                select(PartnerStoreCampaign, CampaignMapping)
                .join(CampaignMapping, CampaignMapping.id == PartnerStoreCampaign.campaign_mapping_id)
                .where(PartnerStoreCampaign.partner_store_id == store.id)
                .order_by(CampaignMapping.display_name)
            )
        ).all()
    ]
    channels = [
        {
            "id": str(row.id),
            "channel_type": row.channel_type,
            "platform": row.platform,
            "label": row.label,
            "enabled": row.enabled,
        }
        for row in (
            await db.execute(
                select(PartnerStoreChannel)
                .where(PartnerStoreChannel.partner_store_id == store.id)
                .order_by(PartnerStoreChannel.label)
            )
        ).scalars().all()
    ]
    sources = (
        await db.execute(
            select(PartnerInventorySource)
            .where(PartnerInventorySource.partner_store_id == store.id)
            .order_by(PartnerInventorySource.source_name)
        )
    ).scalars().all()
    urls_by_source: dict = {}
    if sources:
        for url in (
            await db.execute(
                select(PartnerInventoryUrl).where(
                    PartnerInventoryUrl.inventory_source_id.in_([row.id for row in sources])
                )
            )
        ).scalars().all():
            urls_by_source.setdefault(url.inventory_source_id, []).append(
                {"url": url.url, "inventory_type": url.inventory_type}
            )

    base = LeadDelivery.partner_store_id == store.id
    total = (
        await db.execute(select(func.count(LeadDelivery.id)).where(base))
    ).scalar_one()
    active_sent, month_sent = (await active_send_counts(db, [store.id])).get(store.id, (0, 0))
    status_rows = (
        await db.execute(
            select(LeadDelivery.status, func.count(LeadDelivery.id))
            .where(base)
            .group_by(LeadDelivery.status)
        )
    ).all()
    sender_rows = (
        await db.execute(
            select(
                LeadDelivery.sent_by_user_id,
                User.first_name,
                User.last_name,
                func.count(LeadDelivery.id),
            )
            .outerjoin(User, User.id == LeadDelivery.sent_by_user_id)
            .where(base)
            .group_by(LeadDelivery.sent_by_user_id, User.first_name, User.last_name)
            .order_by(func.count(LeadDelivery.id).desc())
        )
    ).all()
    sold = (
        await db.execute(
            select(func.count(Lead.id)).where(Lead.sold_partner_store_id == store.id)
        )
    ).scalar_one()

    recent_rows = (
        await db.execute(
            select(LeadDelivery)
            .where(base)
            .order_by(LeadDelivery.delivered_at.desc())
            .limit(100)
        )
    ).scalars().all()
    lead_ids = {row.lead_id for row in recent_rows}
    user_ids = {row.sent_by_user_id for row in recent_rows if row.sent_by_user_id}
    leads = {}
    if lead_ids:
        for lead in (await db.execute(select(Lead).where(Lead.id.in_(lead_ids)))).scalars().all():
            leads[lead.id] = lead
    customers = {}
    customer_ids = {lead.customer_id for lead in leads.values()}
    if customer_ids:
        for customer in (
            await db.execute(select(Customer).where(Customer.id.in_(customer_ids)))
        ).scalars().all():
            customers[customer.id] = customer
    users = {}
    if user_ids:
        for person in (await db.execute(select(User).where(User.id.in_(user_ids)))).scalars().all():
            users[person.id] = person

    recent = []
    for row in recent_rows:
        lead = leads.get(row.lead_id)
        customer = customers.get(lead.customer_id) if lead else None
        sender = users.get(row.sent_by_user_id) if row.sent_by_user_id else None
        sender_name = None
        if sender is not None:
            sender_name = f"{sender.first_name} {sender.last_name}".strip() or sender.email
        recent.append(
            {
                "delivery_id": str(row.id),
                "lead_id": str(row.lead_id),
                "customer_name": customer.full_name if customer else "Customer",
                "phone": customer.phone if customer else None,
                "email": customer.email if customer else None,
                "sent_at": row.delivered_at.isoformat() if row.delivered_at else None,
                "sent_by": sender_name,
                "delivery_status": row.status,
                "lead_outcome": lead.outcome if lead else None,
                "program_type": row.program_type,
            }
        )

    opt_in = None
    if program is not None and program.status != "cancelled":
        opt_in = program.program_type

    return {
        "id": str(store.id),
        "name": store.name,
        "brand": store.brand,
        "email": store.email,
        "phone": store.phone,
        "website": store.website,
        "contact_person": store.contact_person,
        "address": store.address,
        "city": store.city,
        "state": store.state,
        "postal_code": store.postal_code,
        "external_code": store.external_code,
        "is_active": store.is_active,
        "opt_in": opt_in,
        "monthly_leads_min": store.monthly_leads_min,
        "monthly_leads_max": store.monthly_leads_max,
        "sent_this_month": int(month_sent or 0),
        "leads_sent": int(active_sent or 0),
        "range_position": range_position(
            int(month_sent or 0), store.monthly_leads_min, store.monthly_leads_max
        ),
        "recipient_emails": recipients,
        "campaigns": campaigns,
        "lead_channels": channels,
        "inventory_sources": [
            {
                "source_id": row.external_source_id,
                "source_name": row.source_name,
                "platforms": list(row.platforms or []),
                "enabled": row.enabled,
                "inventory_urls": urls_by_source.get(row.id, []),
            }
            for row in sources
        ],
        "metrics": {
            "total_sent": int(total or 0),
            "sent_this_month": int(month_sent or 0),
            "sold": int(sold or 0),
            "by_status": [
                {"status": status, "count": int(count)} for status, count in status_rows
            ],
            "by_sender": [
                {
                    "user_id": str(user_id) if user_id else None,
                    "name": (
                        f"{first or ''} {last or ''}".strip() or "Unknown"
                    ),
                    "count": int(count),
                }
                for user_id, first, last, count in sender_rows
            ],
        },
        "leads": recent,
    }


async def load_profile(db: AsyncSession, store_id: UUID) -> dict:
    from app.models.partner_store_campaign import PartnerStoreCampaign as Link

    recipients = [
        row.email
        for row in (
            await db.execute(
                select(PartnerStoreRecipient)
                .where(PartnerStoreRecipient.partner_store_id == store_id)
                .order_by(PartnerStoreRecipient.email)
            )
        ).scalars().all()
    ]
    campaign_ids = [
        row.campaign_mapping_id
        for row in (
            await db.execute(
                select(Link).where(Link.partner_store_id == store_id)
            )
        ).scalars().all()
    ]
    channels = [
        {
            "channel_type": row.channel_type,
            "platform": row.platform,
            "label": row.label,
            "enabled": row.enabled,
        }
        for row in (
            await db.execute(
                select(PartnerStoreChannel)
                .where(PartnerStoreChannel.partner_store_id == store_id)
                .order_by(PartnerStoreChannel.label)
            )
        ).scalars().all()
    ]
    sources = (
        await db.execute(
            select(PartnerInventorySource).where(
                PartnerInventorySource.partner_store_id == store_id
            )
        )
    ).scalars().all()
    urls_by_source: dict = {}
    if sources:
        for url in (
            await db.execute(
                select(PartnerInventoryUrl).where(
                    PartnerInventoryUrl.inventory_source_id.in_([row.id for row in sources])
                )
            )
        ).scalars().all():
            urls_by_source.setdefault(url.inventory_source_id, []).append(
                {"url": url.url, "inventory_type": url.inventory_type}
            )
    program = (
        await db.execute(
            select(PartnerProgram).where(PartnerProgram.partner_store_id == store_id)
        )
    ).scalar_one_or_none()
    opt_in = "leads_only"
    if program is not None and program.program_type in ("leads_only", "full_bdc"):
        if program.status != "cancelled":
            opt_in = program.program_type
    return {
        "opt_in": opt_in,
        "recipient_emails": recipients,
        "campaign_mapping_ids": campaign_ids,
        "lead_channels": channels,
        "inventory_sources": [
            {
                "source_id": row.external_source_id,
                "source_name": row.source_name,
                "platforms": list(row.platforms or []),
                "enabled": row.enabled,
                "inventory_urls": urls_by_source.get(row.id, []),
            }
            for row in sources
        ],
    }
