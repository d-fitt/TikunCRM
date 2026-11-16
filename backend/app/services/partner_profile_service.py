"""Validate and replace a partner store's opt-in, recipients, sources, and inventory."""
import re
from typing import Iterable, Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.timezone import utc_now
from app.models.campaign_mapping import CampaignMapping
from app.models.partner_inventory import (
    INVENTORY_TYPES,
    PartnerInventorySource,
    PartnerInventoryUrl,
)
from app.models.partner_program import PROGRAM_ACTIVE, PROGRAM_TYPES, PartnerProgram
from app.models.partner_store import PartnerStore
from app.models.partner_store_campaign import PartnerStoreCampaign
from app.models.partner_store_channel import CHANNEL_MARKETPLACE, CHANNEL_TYPES, PartnerStoreChannel
from app.models.partner_store_recipient import PartnerStoreRecipient

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_SOURCE_CODE = re.compile(r"^[A-Za-z0-9_-]{1,50}$")


class ProfileError(ValueError):
    """A store profile the API should reject with 400."""


def validate_monthly_range(low: Optional[int], high: Optional[int]) -> None:
    if low is None and high is None:
        return
    if low is None or high is None:
        raise ProfileError("Monthly leads need both a minimum and a maximum.")
    if low < 0 or high < 0:
        raise ProfileError("Monthly leads cannot be negative.")
    if low > high:
        raise ProfileError("Monthly lead minimum cannot be higher than the maximum.")
    if high > 100000:
        raise ProfileError("Monthly lead maximum is too large.")


def normalize_email(value: str) -> str:
    email = (value or "").strip().lower()
    if not email or len(email) > 254 or not _EMAIL.match(email):
        raise ProfileError(f"Invalid recipient email: {value!r}")
    return email


def normalize_emails(values: Iterable[str]) -> list[str]:
    cleaned = []
    seen = set()
    for value in values or []:
        email = normalize_email(value)
        if email in seen:
            continue
        seen.add(email)
        cleaned.append(email)
    if len(cleaned) > 30:
        raise ProfileError("A store can have at most 30 recipient emails.")
    return cleaned


def slug_platform(value: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "_", (value or "").strip().lower()).strip("_")
    if not text or len(text) > 100:
        raise ProfileError(f"Invalid platform: {value!r}")
    return text


def _clean_platforms(values: Iterable[str]) -> list[str]:
    cleaned = []
    seen = set()
    for value in values or []:
        if not str(value).strip():
            continue
        slug = slug_platform(str(value))
        if slug in seen:
            continue
        seen.add(slug)
        cleaned.append(slug)
    if len(cleaned) > 20:
        raise ProfileError("An inventory source can list at most 20 platforms.")
    return cleaned


def _validate_url(value: str) -> str:
    url = (value or "").strip()
    if not url.startswith(("http://", "https://")) or len(url) > 2000 or " " in url:
        raise ProfileError(f"Inventory URL must be a full http(s) link: {value!r}")
    return url


async def replace_store_profile(
    db: AsyncSession,
    store: PartnerStore,
    *,
    opt_in: str,
    recipient_emails: list[str],
    campaign_mapping_ids: list[UUID],
    lead_channels: list[dict],
    inventory_sources: list[dict],
) -> None:
    if opt_in not in PROGRAM_TYPES:
        raise ProfileError("Opt-in must be leads only or leads + BDC.")
    emails = normalize_emails(recipient_emails)
    campaign_ids = list(dict.fromkeys(campaign_mapping_ids))
    if len(campaign_ids) > 100:
        raise ProfileError("A store can be linked to at most 100 campaigns.")
    if campaign_ids:
        found = set(
            (
                await db.execute(
                    select(CampaignMapping.id).where(CampaignMapping.id.in_(campaign_ids))
                )
            ).scalars().all()
        )
        if found != set(campaign_ids):
            raise ProfileError("One or more campaigns were not found.")

    channels = _normalize_channels(lead_channels)
    sources = _normalize_inventory(inventory_sources)

    program = (
        await db.execute(
            select(PartnerProgram).where(PartnerProgram.partner_store_id == store.id)
        )
    ).scalar_one_or_none()
    if program is None:
        program = PartnerProgram(
            partner_store_id=store.id,
            program_type=opt_in,
            status=PROGRAM_ACTIVE,
            states=[],
            postal_codes=[],
            hours={},
        )
        db.add(program)
    else:
        program.program_type = opt_in
        program.status = PROGRAM_ACTIVE
        program.updated_at = utc_now()

    await _replace_rows(
        db,
        select(PartnerStoreRecipient).where(PartnerStoreRecipient.partner_store_id == store.id),
    )
    for email in emails:
        db.add(PartnerStoreRecipient(partner_store_id=store.id, email=email))

    await _replace_rows(
        db,
        select(PartnerStoreCampaign).where(PartnerStoreCampaign.partner_store_id == store.id),
    )
    for campaign_id in campaign_ids:
        db.add(
            PartnerStoreCampaign(
                partner_store_id=store.id,
                campaign_mapping_id=campaign_id,
            )
        )

    await _replace_rows(
        db,
        select(PartnerStoreChannel).where(PartnerStoreChannel.partner_store_id == store.id),
    )
    for channel in channels:
        db.add(PartnerStoreChannel(partner_store_id=store.id, **channel))

    existing_sources = (
        await db.execute(
            select(PartnerInventorySource).where(
                PartnerInventorySource.partner_store_id == store.id
            )
        )
    ).scalars().all()
    source_ids = [row.id for row in existing_sources]
    if source_ids:
        urls = (
            await db.execute(
                select(PartnerInventoryUrl).where(
                    PartnerInventoryUrl.inventory_source_id.in_(source_ids)
                )
            )
        ).scalars().all()
        for url in urls:
            await db.delete(url)
        await db.flush()
    for row in existing_sources:
        await db.delete(row)
    await db.flush()

    for source in sources:
        urls = source.pop("urls")
        row = PartnerInventorySource(partner_store_id=store.id, **source)
        db.add(row)
        await db.flush()
        for url in urls:
            db.add(PartnerInventoryUrl(inventory_source_id=row.id, **url))


def _normalize_channels(values: list[dict]) -> list[dict]:
    if len(values or []) > 40:
        raise ProfileError("A store can have at most 40 lead sources.")
    cleaned = []
    seen = set()
    for raw in values or []:
        channel_type = str(raw.get("channel_type") or "").strip().lower()
        if channel_type not in CHANNEL_TYPES:
            raise ProfileError("Lead source type must be marketplace, website, or other.")
        label = str(raw.get("label") or "").strip()
        if not label or len(label) > 255:
            raise ProfileError("Each lead source needs a name.")
        platform_raw = str(raw.get("platform") or "").strip()
        if channel_type == CHANNEL_MARKETPLACE and not platform_raw:
            raise ProfileError(f"{label} needs a platform.")
        platform = slug_platform(platform_raw) if platform_raw else ""
        key = (channel_type, platform, label.casefold())
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(
            {
                "channel_type": channel_type,
                "platform": platform,
                "label": label,
                "enabled": bool(raw.get("enabled", True)),
            }
        )
    return cleaned


def _normalize_inventory(values: list[dict]) -> list[dict]:
    if len(values or []) > 30:
        raise ProfileError("A store can have at most 30 inventory sources.")
    cleaned = []
    seen_codes = set()
    for raw in values or []:
        name = str(raw.get("source_name") or "").strip()
        if not name or len(name) > 255:
            raise ProfileError("Each inventory source needs a name.")
        code = str(raw.get("source_id") or raw.get("external_source_id") or "").strip()
        if code:
            if not _SOURCE_CODE.match(code):
                raise ProfileError(f"Invalid inventory source id: {code}")
            folded = code.casefold()
            if folded in seen_codes:
                raise ProfileError(f"Duplicate inventory source id: {code}")
            seen_codes.add(folded)
        urls_in = raw.get("inventory_urls") or raw.get("urls") or []
        if not isinstance(urls_in, list) or not urls_in:
            raise ProfileError(f"{name} needs at least one inventory URL.")
        if len(urls_in) > 20:
            raise ProfileError(f"{name} has too many inventory URLs.")
        urls = []
        for item in urls_in:
            inventory_type = str(item.get("inventory_type") or "").strip().lower()
            if inventory_type not in INVENTORY_TYPES:
                raise ProfileError("Inventory type must be new, used, or cpo.")
            urls.append(
                {
                    "url": _validate_url(str(item.get("url") or "")),
                    "inventory_type": inventory_type,
                }
            )
        cleaned.append(
            {
                "external_source_id": code or None,
                "source_name": name,
                "platforms": _clean_platforms(raw.get("platforms") or []),
                "enabled": bool(raw.get("enabled", True)),
                "urls": urls,
            }
        )
    return cleaned


async def _replace_rows(db: AsyncSession, query) -> None:
    rows = (await db.execute(query)).scalars().all()
    for row in rows:
        await db.delete(row)
    await db.flush()
