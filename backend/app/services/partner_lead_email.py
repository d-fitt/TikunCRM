"""Email a partner store when a person sends them a lead.

Uses the lead-delivery mailbox only. TikunCRM notification SMTP is not used.
The portal mailbox wins. The server settings are the fallback until a super admin saves one.
"""
import html
import logging
import smtplib
import ssl
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from typing import Optional
from zoneinfo import ZoneInfo

import httpx

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
    graph_tenant_id: str = ""
    graph_client_id: str = ""
    graph_client_secret: str = ""

    @property
    def graph_ready(self) -> bool:
        return bool(self.user and self.graph_tenant_id and self.graph_client_id and self.graph_client_secret)

    @property
    def ready(self) -> bool:
        return self.graph_ready or bool(self.user and self.password)


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


def _saved_secret(encrypted: str) -> str:
    if not encrypted:
        return ""
    try:
        return decrypt_value(encrypted).strip()
    except Exception:
        logger.warning("Could not read the saved lead-delivery app secret")
        return ""


async def resolve_delivery_mailbox(db: AsyncSession) -> DeliveryMailbox:
    row = (await db.execute(select(LeadDeliveryMailbox).limit(1))).scalar_one_or_none()
    if row is None or not (row.smtp_user or "").strip():
        return _server_mailbox()
    password = _saved_secret(row.smtp_password_encrypted).replace(" ", "")
    graph_secret = _saved_secret(row.graph_client_secret_encrypted)
    if password or graph_secret:
        return DeliveryMailbox(
            host=row.smtp_host,
            port=row.smtp_port,
            user=row.smtp_user.strip(),
            password=password,
            use_tls=row.use_tls,
            use_ssl=row.use_ssl,
            from_name=(row.from_name or "Carvaminos").strip() or "Carvaminos",
            source="portal",
            graph_tenant_id=(row.graph_tenant_id or "").strip(),
            graph_client_id=(row.graph_client_id or "").strip(),
            graph_client_secret=graph_secret,
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


_token_lock = threading.Lock()
_token_cache = {"key": "", "token": "", "expires_at": 0.0}


def _graph_access_token(mailbox: DeliveryMailbox) -> tuple[str, str]:
    """Return a Graph token, asking Microsoft for a new one when the last one is near expiry."""
    cache_key = f"{mailbox.graph_tenant_id}:{mailbox.graph_client_id}"
    now = time.time()
    with _token_lock:
        if _token_cache["key"] == cache_key and _token_cache["expires_at"] > now + 120:
            return _token_cache["token"], ""
    response = httpx.post(
        f"https://login.microsoftonline.com/{mailbox.graph_tenant_id}/oauth2/v2.0/token",
        data={
            "client_id": mailbox.graph_client_id,
            "client_secret": mailbox.graph_client_secret,
            "scope": "https://graph.microsoft.com/.default",
            "grant_type": "client_credentials",
        },
        timeout=30,
    )
    try:
        payload = response.json()
    except Exception:
        payload = {}
    if response.status_code != 200 or not payload.get("access_token"):
        return "", _graph_auth_error(payload, response.status_code)
    expires_in = int(payload.get("expires_in") or 3600)
    with _token_lock:
        _token_cache["key"] = cache_key
        _token_cache["token"] = payload["access_token"]
        _token_cache["expires_at"] = time.time() + max(expires_in, 60)
    return payload["access_token"], ""


def _graph_auth_error(payload: dict, status_code: int) -> str:
    code = str(payload.get("error") or "")
    description = str(payload.get("error_description") or "")
    text = f"{code} {description}".lower()
    if "7000215" in text or "invalid client secret" in text:
        return "Microsoft rejected the app secret. Paste the secret value again and save."
    if "700016" in text or "7000229" in text:
        return "Microsoft could not find this application. Check the tenant ID and client ID."
    if description:
        return description.split("\r\n", 1)[0][:300]
    return f"Microsoft did not issue a send token ({status_code})."


def _graph_send_error(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except Exception:
        payload = {}
    error = payload.get("error") if isinstance(payload, dict) else None
    code = ""
    message = ""
    if isinstance(error, dict):
        code = str(error.get("code") or "")
        message = str(error.get("message") or "")
    text = f"{code} {message}".lower()
    if response.status_code == 403 or "erroraccessdenied" in text or "errorsendasdenied" in text:
        return (
            "This app cannot send as this mailbox yet. "
            "Exchange Application RBAC must allow Mail.Send only for this address."
        )
    if response.status_code == 404:
        return "Microsoft could not find this mailbox. Save the full address, such as leads@carvamonos.com."
    if message:
        return message[:300]
    return f"Microsoft Graph did not accept the message ({response.status_code})."


def _send_graph(mailbox: DeliveryMailbox, to_email: str, subject: str, body_html: str) -> tuple[bool, str]:
    token, token_error = _graph_access_token(mailbox)
    if token_error:
        return False, token_error
    sender = mailbox.user
    response = httpx.post(
        f"https://graph.microsoft.com/v1.0/users/{sender}/sendMail",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "message": {
                "subject": subject,
                "body": {"contentType": "HTML", "content": body_html},
                "toRecipients": [{"emailAddress": {"address": to_email}}],
            },
            "saveToSentItems": True,
        },
        timeout=30,
    )
    if response.status_code in (202, 200):
        return True, ""
    if response.status_code == 401:
        with _token_lock:
            _token_cache["expires_at"] = 0
        return False, "Microsoft expired the send token. Send the test again."
    logger.warning("Graph lead email failed for %s status %s", sender, response.status_code)
    return False, _graph_send_error(response)


def send_partner_lead_email_sync(
    mailbox: DeliveryMailbox,
    to_email: str,
    subject: str,
    body_text: str,
    body_html: str,
) -> tuple[bool, str]:
    if not mailbox.ready:
        logger.warning("Lead delivery email skipped: no mailbox is configured")
        return False, "No mailbox is configured."
    if mailbox.graph_ready:
        try:
            return _send_graph(mailbox, to_email, subject, body_html)
        except httpx.HTTPError:
            logger.exception("Lead delivery Graph request failed for %s", mailbox.user)
            return False, "Could not reach Microsoft Graph. Try the test again."
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
        return True, ""
    except smtplib.SMTPAuthenticationError as exc:
        logger.warning("Lead delivery login rejected for %s via %s", mailbox.user, mailbox.host)
        detail = str(exc)
        if "security defaults" in detail.lower():
            return False, (
                "Microsoft locked this mailbox with Security Defaults. "
                "An admin must allow SMTP sending for this mailbox, then send the test again."
            )
        if "SmtpClientAuthentication is disabled" in detail or "5.7.139" in detail:
            return False, (
                "Microsoft has SMTP sending turned off for the whole company. "
                "An admin must turn on Authenticated SMTP, then send the test again."
            )
        return False, (
            "The mail server rejected the login. Use the app password, not the normal sign-in password."
        )
    except Exception:
        logger.exception("Lead delivery email failed for %s via %s", mailbox.user, mailbox.host)
        return False, "Could not reach the Microsoft mail server. Try the test again."


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
