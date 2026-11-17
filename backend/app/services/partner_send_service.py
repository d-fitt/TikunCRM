"""Send one lead to one or more partner stores. A person chooses the stores."""
import logging
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
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
class SendDetails:
    """Optional details filled in at send time. Blank values are left unchanged."""
    postal_code: Optional[str] = None
    email: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    down_payment: Optional[Decimal] = None
    clear_down_payment: bool = False
    is_business: Optional[bool] = None
    clear_business: bool = False
    interested_in: Optional[str] = None
    interested_brand: Optional[str] = None
    budget_range: Optional[str] = None


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


def _apply_send_details(lead: Lead, customer: Optional[Customer], details: Optional[SendDetails]) -> None:
    """Apply only the fields the sender included. A blank value removes it from the email."""
    if details is None:
        return
    if customer is not None and details.postal_code is not None:
        customer.postal_code = details.postal_code.strip()[:20] or None
    if customer is not None and details.city is not None:
        customer.city = details.city.strip()[:100] or None
    if customer is not None and details.state is not None:
        customer.state = details.state.strip()[:100] or None
    if customer is not None and details.email is not None:
        email = details.email.strip()
        if email and "@" not in email:
            raise SendError("Enter a valid email or leave it blank.")
        customer.email = email[:255] or None
    if details.interested_in is not None:
        lead.interested_in = details.interested_in.strip()[:255] or None
    if details.interested_brand is not None:
        lead.interested_brand = details.interested_brand.strip()[:100] or None
    if details.budget_range is not None:
        lead.budget_range = details.budget_range.strip()[:100] or None
    if details.down_payment is not None:
        if details.down_payment < 0:
            raise SendError("Down payment cannot be negative.")
        lead.down_payment = details.down_payment
    if details.clear_down_payment:
        lead.down_payment = None
    if details.is_business is not None or details.clear_business:
        lead.is_business = None if details.clear_business else details.is_business


async def send_lead_to_stores(
    db: AsyncSession,
    lead: Lead,
    store_ids: list[UUID],
    user: User,
    details: Optional[SendDetails] = None,
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
    _apply_send_details(lead, customer, details)
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
        await _email_stores(db, fresh, by_id, customer, user, lead)
    return results


async def _email_stores(
    db: AsyncSession,
    results: list[StoreSendResult],
    stores: dict,
    customer: Optional[Customer],
    user: User,
    lead: Lead,
) -> None:
    import asyncio

    from app.services.partner_lead_email import (
        build_partner_lead_email,
        resolve_delivery_mailbox,
        send_partner_lead_email_sync,
    )

    mailbox = await resolve_delivery_mailbox(db)
    if not mailbox.ready:
        for item in results:
            if item.recipients:
                item.email_error = "The lead was saved. The lead-delivery mailbox is not configured yet."
            else:
                item.email_error = "This store has no recipient emails."
        return

    for item in results:
        if not item.recipients:
            item.email_error = "This store has no recipient emails."
            continue
        store = stores[item.partner_store_id]
        subject, body_text, body_html = build_partner_lead_email(
            store=store,
            customer=customer,
            user=user,
            lead=lead,
            program_type=item.program_type,
            sent_at=lead.partner_connected_at,
            from_name=mailbox.from_name,
        )
        emailed = []
        errors = []
        for address in item.recipients:
            try:
                ok, reason = await asyncio.to_thread(
                    send_partner_lead_email_sync,
                    mailbox,
                    address,
                    subject,
                    body_text,
                    body_html,
                )
                if ok:
                    emailed.append(address)
                else:
                    errors.append(reason or "The lead was saved. Email could not be sent.")
            except Exception:
                logger.exception("Partner lead email failed for %s", address)
                errors.append("The lead was saved. Email could not be sent.")
        item.emailed = emailed
        if errors and not emailed:
            item.email_error = errors[0]
        elif errors:
            item.email_error = "The lead was saved. Some recipient emails could not be sent."
