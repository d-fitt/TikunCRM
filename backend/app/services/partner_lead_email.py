"""Email a partner store when a person sends them a lead.

Uses the lead-delivery mailbox only. TikunCRM notification SMTP is not used.
The portal mailbox wins. The server settings are the fallback until a super admin saves one.
"""
import html
import logging
import smtplib
import ssl
from dataclasses import dataclass
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.encryption import decrypt_value
from app.models.customer import Customer
from app.models.lead import Lead
from app.models.lead_delivery_mailbox import LeadDeliveryMailbox
from app.models.partner_store import PartnerStore
from app.models.user import User

logger = logging.getLogger(__name__)

_BUSINESS_TZ = ZoneInfo("America/New_York")


@dataclass
class DeliveryMailbox:
    host: str
    port: int
    user: str
    password: str
    use_tls: bool
    use_ssl: bool
    from_name: str
    source: str

    @property
    def ready(self) -> bool:
        return bool(self.user and self.password)


def _server_mailbox() -> DeliveryMailbox:
    return DeliveryMailbox(
        host=settings.lead_delivery_smtp_host or "smtp.office365.com",
        port=settings.lead_delivery_smtp_port or 587,
        user=(settings.lead_delivery_smtp_user or "").strip(),
        password=(settings.lead_delivery_smtp_password or "").replace(" ", ""),
        use_tls=settings.lead_delivery_smtp_use_tls,
        use_ssl=settings.lead_delivery_smtp_use_ssl,
        from_name=(settings.lead_delivery_from_name or "Carvaminos").strip() or "Carvaminos",
        source="server" if settings.lead_delivery_smtp_user and settings.lead_delivery_smtp_password else "none",
    )


async def resolve_delivery_mailbox(db: AsyncSession) -> DeliveryMailbox:
    row = (await db.execute(select(LeadDeliveryMailbox).limit(1))).scalar_one_or_none()
    if row and row.smtp_user and row.smtp_password_encrypted:
        password = decrypt_value(row.smtp_password_encrypted).replace(" ", "")
        if password:
            return DeliveryMailbox(
                host=row.smtp_host,
                port=row.smtp_port,
                user=row.smtp_user.strip(),
                password=password,
                use_tls=row.use_tls,
                use_ssl=row.use_ssl,
                from_name=(row.from_name or "Carvaminos").strip() or "Carvaminos",
                source="portal",
            )
    return _server_mailbox()


def build_partner_lead_email(
    *,
    store: PartnerStore,
    customer: Optional[Customer],
    user: User,
    lead: Lead,
    program_type: str,
    sent_at: Optional[datetime] = None,
    from_name: str = "Carvaminos",
) -> tuple[str, str, str]:
    """Return subject, plain text, and HTML for one store."""
    name = _customer_name(customer)
    phone = _clean(customer.phone if customer else None)
    email = _clean(customer.email if customer else None)
    postal = _clean(customer.postal_code if customer else None)
    city = _place(customer)
    interest = _clean(lead.interested_in)
    brand = _clean(lead.interested_brand)
    source = _source(lead)
    down_payment = _meta_value(lead, "downpayment", "down_payment")
    sender = f"{user.first_name or ''} {user.last_name or ''}".strip() or user.email
    when = (sent_at or datetime.now(_BUSINESS_TZ)).astimezone(_BUSINESS_TZ)
    when_label = when.strftime("%b %-d, %Y, %-I:%M %p ET")
    program = "Leads + BDC" if program_type == "full_bdc" else "Leads only"
    brand_name = (from_name or "Carvaminos").strip() or "Carvaminos"
    subject = f"New lead: {name} — {store.name}"

    rows = [
        ("Phone", phone or "—"),
        ("Email", email or "—"),
        ("ZIP", postal or "—"),
        ("City", city or "—"),
        ("Looking for", interest or "—"),
        ("Brand", brand or "—"),
    ]
    if source:
        rows.append(("Source", source))
    if down_payment:
        rows.append(("Down payment", down_payment))
    rows.append(("Sent by", sender))
    rows.append(("Sent", when_label))
    rows.append(("Program", program))

    text_lines = [
        f"New lead for {store.name}",
        "",
        name,
        "",
    ]
    text_lines.extend(f"{label}: {value}" for label, value in rows)
    text_lines.extend(["", f"Sent to {store.name} by {brand_name}."])
    text = "\n".join(text_lines)

    detail_rows = "\n".join(
        "<tr>"
        f'<td style="padding:10px 0;border-bottom:1px solid #e7e5e4;width:132px;color:#78716c;font-size:13px;">{html.escape(label)}</td>'
        f'<td style="padding:10px 0;border-bottom:1px solid #e7e5e4;color:#1c1917;font-size:15px;font-weight:600;">{_cell_value(label, value)}</td>'
        "</tr>"
        for label, value in rows
    )
    body_html = f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f5f4;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="background:#1c1917;padding:22px 28px;">
              <div style="color:#a8a29e;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">{html.escape(brand_name)}</div>
              <div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:6px;">New lead for {html.escape(store.name)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 28px 8px;">
              <div style="font-size:20px;font-weight:700;color:#1c1917;">{html.escape(name)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                {detail_rows}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 24px;color:#78716c;font-size:12px;line-height:1.5;">
              Sent to {html.escape(store.name)} by {html.escape(brand_name)}. Reply to this email if a detail needs a correction.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""
    return subject, text, body_html


def send_partner_lead_email_sync(
    mailbox: DeliveryMailbox,
    to_email: str,
    subject: str,
    body_text: str,
    body_html: str,
) -> bool:
    if not mailbox.ready:
        logger.warning("Lead delivery email skipped: no mailbox is configured")
        return False
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = formataddr((mailbox.from_name, mailbox.user))
    msg["To"] = to_email
    msg.attach(MIMEText(body_text, "plain"))
    msg.attach(MIMEText(body_html, "html"))
    try:
        if mailbox.use_ssl:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(mailbox.host, mailbox.port, context=context, timeout=30) as server:
                server.login(mailbox.user, mailbox.password)
                server.send_message(msg)
        else:
            with smtplib.SMTP(mailbox.host, mailbox.port, timeout=30) as server:
                if mailbox.use_tls:
                    server.starttls(context=ssl.create_default_context())
                server.login(mailbox.user, mailbox.password)
                server.send_message(msg)
        return True
    except Exception:
        logger.exception("Lead delivery email failed for %s", to_email)
        return False


def _customer_name(customer: Optional[Customer]) -> str:
    if customer is None:
        return "Customer"
    name = f"{customer.first_name or ''} {customer.last_name or ''}".strip()
    return name or "Customer"


def _clean(value: Optional[str]) -> str:
    return (value or "").strip()


def _place(customer: Optional[Customer]) -> str:
    if customer is None:
        return ""
    parts = [part.strip() for part in (customer.city or "", customer.state or "") if part and part.strip()]
    return ", ".join(parts)


def _source(lead: Lead) -> str:
    meta = lead.meta_data or {}
    display = meta.get("source_display") if isinstance(meta, dict) else None
    return _clean(display if isinstance(display, str) else None) or _clean(lead.source_campaign_raw)


def _meta_value(lead: Lead, *keys: str) -> str:
    meta = lead.meta_data or {}
    if not isinstance(meta, dict):
        return ""
    for key in keys:
        value = meta.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _cell_value(label: str, value: str) -> str:
    safe = html.escape(value)
    if label == "Phone" and value not in {"", "—"}:
        dial = "".join(ch for ch in value if ch.isdigit() or ch == "+")
        return f'<a href="tel:{html.escape(dial)}" style="color:#1c1917;text-decoration:none;">{safe}</a>'
    if label == "Email" and value not in {"", "—"}:
        return f'<a href="mailto:{safe}" style="color:#1c1917;text-decoration:none;">{safe}</a>'
    return safe
