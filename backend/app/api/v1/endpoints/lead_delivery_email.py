"""Super admin sets the Microsoft mailbox that sends leads to partner stores."""
import asyncio
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_super_admin
from app.core.encryption import encrypt_value
from app.core.timezone import utc_now
from app.db.database import get_db
from app.models.lead_delivery_mailbox import LeadDeliveryMailbox
from app.models.user import User
from app.services.partner_lead_email import (
    resolve_delivery_mailbox,
    send_partner_lead_email_sync,
)

router = APIRouter()

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_CONSUMER_DOMAINS = {"outlook.com", "hotmail.com", "live.com", "msn.com"}
_HOSTS = {
    "microsoft365": "smtp.office365.com",
    "outlook": "smtp-mail.outlook.com",
}


def mailbox_host(email: str) -> tuple[str, str]:
    """Company addresses use Microsoft 365. Outlook.com is only for consumer addresses."""
    domain = email.rsplit("@", 1)[-1]
    if domain in _CONSUMER_DOMAINS:
        return _HOSTS["outlook"], "outlook"
    return _HOSTS["microsoft365"], "microsoft365"


class MailboxResponse(BaseModel):
    smtp_host: str
    smtp_port: int
    smtp_user: str
    from_name: str
    use_tls: bool
    use_ssl: bool
    has_password: bool
    active_email: str
    source: str


class MailboxUpdate(BaseModel):
    smtp_user: str = Field(..., max_length=255)
    password: Optional[str] = Field(None, max_length=200)
    from_name: str = Field("Carvaminos", max_length=255)
    provider: str = Field("microsoft365")


class MailboxTest(BaseModel):
    to_email: str = Field(..., max_length=255)


def _public(row: Optional[LeadDeliveryMailbox], active_email: str, source: str) -> MailboxResponse:
    if row is None:
        return MailboxResponse(
            smtp_host="smtp.office365.com",
            smtp_port=587,
            smtp_user="",
            from_name="Carvaminos",
            use_tls=True,
            use_ssl=False,
            has_password=False,
            active_email=active_email,
            source=source,
        )
    return MailboxResponse(
        smtp_host=row.smtp_host,
        smtp_port=row.smtp_port,
        smtp_user=row.smtp_user,
        from_name=row.from_name,
        use_tls=row.use_tls,
        use_ssl=row.use_ssl,
        has_password=bool(row.smtp_password_encrypted),
        active_email=active_email,
        source=source,
    )


@router.get("/lead-delivery-email", response_model=MailboxResponse)
async def get_lead_delivery_email(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_super_admin),
) -> MailboxResponse:
    row = (await db.execute(select(LeadDeliveryMailbox).limit(1))).scalar_one_or_none()
    active = await resolve_delivery_mailbox(db)
    return _public(row, active.user if active.ready else "", active.source if active.ready else "none")


@router.put("/lead-delivery-email", response_model=MailboxResponse)
async def save_lead_delivery_email(
    body: MailboxUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_super_admin),
) -> MailboxResponse:
    email = body.smtp_user.strip().lower()
    if not _EMAIL.match(email):
        raise HTTPException(status_code=400, detail="Enter a valid mailbox address.")
    host, _provider = mailbox_host(email)
    from_name = body.from_name.strip() or "Carvaminos"
    row = (await db.execute(select(LeadDeliveryMailbox).limit(1))).scalar_one_or_none()
    password = (body.password or "").strip()
    if row is None:
        if not password:
            raise HTTPException(status_code=400, detail="Enter the mailbox password.")
        row = LeadDeliveryMailbox()
        db.add(row)
    if password:
        row.smtp_password_encrypted = encrypt_value(password.replace(" ", ""))
    elif not row.smtp_password_encrypted:
        raise HTTPException(status_code=400, detail="Enter the mailbox password.")
    row.smtp_host = host
    row.smtp_port = 587
    row.smtp_user = email
    row.from_name = from_name
    row.use_tls = True
    row.use_ssl = False
    row.updated_at = utc_now()
    await db.commit()
    await db.refresh(row)
    active = await resolve_delivery_mailbox(db)
    return _public(row, active.user if active.ready else "", active.source if active.ready else "none")


@router.post("/lead-delivery-email/test")
async def test_lead_delivery_email(
    body: MailboxTest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_super_admin),
) -> dict:
    to_email = body.to_email.strip().lower()
    if not _EMAIL.match(to_email):
        raise HTTPException(status_code=400, detail="Enter a valid address to receive the test.")
    mailbox = await resolve_delivery_mailbox(db)
    if not mailbox.ready:
        raise HTTPException(status_code=400, detail="Save the mailbox before sending a test.")
    ok, reason = await asyncio.to_thread(
        send_partner_lead_email_sync,
        mailbox,
        to_email,
        "Lead delivery mailbox is ready",
        f"This message confirms {mailbox.user} can send partner-store leads.",
        f"<p>This message confirms <strong>{mailbox.user}</strong> can send partner-store leads.</p>",
    )
    if not ok:
        raise HTTPException(status_code=400, detail=reason)
    return {"sent": True, "to_email": to_email}
