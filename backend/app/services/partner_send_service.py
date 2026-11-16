"""Send one lead to one or more partner stores. A person chooses the stores."""
import logging
from dataclasses import dataclass, field
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.timezone import utc_now
from app.models.customer import Customer
from app.models.lead import Lead
from app.models.lead_delivery import (
    DELIVERY_DELIVERED,
    RELEASED_STATUSES,
    LeadDelivery,
)
from app.models.partner_program import PROGRAM_LEADS_ONLY, PartnerProgram
from app.models.partner_store import PartnerStore
from app.models.partner_store_recipient import PartnerStoreRecipient
from app.models.user import User
from app.services.activity import ActivityService
from app.models.activity import ActivityType
from app.services.partner_routing_service import brand_key

logger = logging.getLogger(__name__)


class SendError(ValueError):
    """A send the API should reject with 400."""


@dataclass
class StoreSendResult:
    partner_store_id: UUID
    partner_store_name: str
    delivery_id: UUID
    status: str
    program_type: str
    recipients: list[str] = field(default_factory=list)
    emailed: list[str] = field(default_factory=list)
    email_error: Optional[str] = None


async def send_lead_to_stores(
    db: AsyncSession,
    lead: Lead,
    store_ids: list[UUID],
    user: User,
) -> list[StoreSendResult]:
    wanted = list(dict.fromkeys(store_ids))
    if not wanted:
        raise SendError("Choose at least one partner store.")
    if len(wanted) > 25:
        raise SendError("A lead can be sent to at most 25 stores at once.")
    if not lead.is_active:
        raise SendError("This lead is not active.")

    stores = (
        await db.execute(select(PartnerStore).where(PartnerStore.id.in_(wanted)))
    ).scalars().all()
    by_id = {store.id: store for store in stores}
    missing = [str(store_id) for store_id in wanted if store_id not in by_id]
    if missing:
        raise SendError("One or more partner stores were not found.")
    inactive = [by_id[store_id].name for store_id in wanted if not by_id[store_id].is_active]
    if inactive:
        raise SendError(f"These stores are inactive: {', '.join(inactive)}.")

    programs = {
        row.partner_store_id: row
        for row in (
            await db.execute(
                select(PartnerProgram).where(PartnerProgram.partner_store_id.in_(wanted))
            )
        ).scalars().all()
    }
    recipients = {}
    for row in (
        await db.execute(
            select(PartnerStoreRecipient).where(
                PartnerStoreRecipient.partner_store_id.in_(wanted)
            )
        )
    ).scalars().all():
        recipients.setdefault(row.partner_store_id, []).append(row.email)

    existing = {
        row.partner_store_id: row
        for row in (
            await db.execute(
                select(LeadDelivery).where(
                    LeadDelivery.lead_id == lead.id,
                    LeadDelivery.partner_store_id.in_(wanted),
                )
            )
        ).scalars().all()
    }

    customer = await db.get(Customer, lead.customer_id)
    pending: list[tuple[StoreSendResult, LeadDelivery]] = []
    newly_sent: list[PartnerStore] = []
    now = utc_now()

    for store_id in wanted:
        store = by_id[store_id]
        program = programs.get(store_id)
        program_type = (
            program.program_type
            if program is not None and program.status == "active"
            else PROGRAM_LEADS_ONLY
        )
        brand = (store.brand or lead.interested_brand or "General").strip() or "General"
        current = existing.get(store_id)
        if current is not None and current.status not in RELEASED_STATUSES:
            pending.append(
                (
                    StoreSendResult(
                        partner_store_id=store.id,
                        partner_store_name=store.name,
                        delivery_id=current.id,
                        status="already_sent",
                        program_type=current.program_type,
                        recipients=recipients.get(store.id, []),
                    ),
                    current,
                )
            )
            continue
        if current is None:
            current = LeadDelivery(
                id=uuid4(),
                lead_id=lead.id,
                customer_id=lead.customer_id,
                brand=brand[:100],
                brand_key=brand_key(brand)[:100] or "general",
                partner_store_id=store.id,
                program_type=program_type,
                status=DELIVERY_DELIVERED,
                sent_by_user_id=user.id,
                delivered_at=now,
            )
            db.add(current)
        else:
            current.brand = brand[:100]
            current.brand_key = brand_key(brand)[:100] or "general"
            current.program_type = program_type
            current.status = DELIVERY_DELIVERED
            current.sent_by_user_id = user.id
            current.delivered_at = now
            current.note = None
        pending.append(
            (
                StoreSendResult(
                    partner_store_id=store.id,
                    partner_store_name=store.name,
                    delivery_id=current.id,
                    status="sent",
                    program_type=program_type,
                    recipients=recipients.get(store.id, []),
                ),
                current,
            )
        )
        newly_sent.append(store)

    try:
        await db.flush()
        results = []
        for item, delivery in pending:
            item.delivery_id = delivery.id
            results.append(item)

        if newly_sent:
            lead.partner_store_id = newly_sent[-1].id
            lead.partner_connected_at = now
            performer = f"{user.first_name} {user.last_name}".strip() or user.email
            names = ", ".join(store.name for store in newly_sent)
            await ActivityService.log_activity(
                db,
                activity_type=ActivityType.LEAD_UPDATED,
                description=f"Lead sent to {names} by {performer}",
                user_id=user.id,
                lead_id=lead.id,
                dealership_id=lead.dealership_id,
                meta_data={
                    "partner_store_ids": [str(store.id) for store in newly_sent],
                    "partner_store_names": [store.name for store in newly_sent],
                    "performer_name": performer,
                },
            )
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise SendError("This lead was just sent to one of those stores. Refresh and try again.")

    fresh = [item for item in results if item.status == "sent"]
    if fresh:
        await _email_stores(fresh, by_id, customer, user, lead)
    return results


async def _email_stores(
    results: list[StoreSendResult],
    stores: dict,
    customer: Optional[Customer],
    user: User,
    lead: Lead,
) -> None:
    from app.services.email_notifier import EmailNotifier

    notifier = EmailNotifier()
    customer_name = customer.full_name if customer else "Customer"
    phone = customer.phone if customer else ""
    email = customer.email if customer else ""
    sender = f"{user.first_name} {user.last_name}".strip() or user.email
    interest = lead.interested_in or ""

    for item in results:
        if not item.recipients:
            item.email_error = "This store has no recipient emails."
            continue
        store = stores[item.partner_store_id]
        opt_in = "Leads + BDC" if item.program_type == "full_bdc" else "Leads only"
        message = (
            f"A lead was sent to {store.name}.\n\n"
            f"Customer: {customer_name}\n"
            f"Phone: {phone or '—'}\n"
            f"Email: {email or '—'}\n"
            f"Interested in: {interest or '—'}\n"
            f"Sent by: {sender}\n"
            f"Opt-in: {opt_in}"
        )
        emailed = []
        errors = []
        for address in item.recipients:
            try:
                ok = await notifier.send_notification_email(
                    to_email=address,
                    to_name=store.name,
                    subject=f"New lead for {store.name}",
                    message=message,
                )
                if ok:
                    emailed.append(address)
                else:
                    errors.append(address)
            except Exception:
                logger.exception("Partner lead email failed for %s", address)
                errors.append(address)
        item.emailed = emailed
        if errors and not emailed:
            item.email_error = "The lead was saved. Email could not be sent."
        elif errors:
            item.email_error = "The lead was saved. Some recipient emails could not be sent."
