"""
SMS consent rules for the A2P 10DLC campaign.

Customers consent separately to inquiry texts (follow-up on their vehicle inquiry,
test drives, appointments) and promotional texts (offers, discounts, photos).
STOP always wins until the customer texts START again.

Twilio's Messaging Service answers the English keywords (STOP, START, HELP...) itself
and passes OptOutType on the inbound webhook. Spanish keywords are not known to
Twilio, so the CRM blocks and answers those itself.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Dict, Iterable, Optional, Tuple
from urllib.parse import urlparse

from app.core.config import settings
from app.core.timezone import utc_now
from app.models.customer import Customer

CATEGORY_CONVERSATION = "conversation"
CATEGORY_AUTO_FIRST = "auto_first"
CATEGORY_PROMOTIONAL = "promotional"
CATEGORY_COMPLIANCE = "compliance"

KEYWORD_OPT_OUT = "opt_out"
KEYWORD_OPT_IN = "opt_in"
KEYWORD_HELP = "help"

_TWILIO_OPT_OUT = {"STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"}
_TWILIO_OPT_IN = {"START", "UNSTOP", "YES"}
_TWILIO_HELP = {"HELP", "INFO"}

_OPT_OUT = _TWILIO_OPT_OUT | {"PARAR", "ALTO", "CANCELAR", "DETENER", "BAJA", "DESUSCRIBIR", "SALIR"}
_OPT_IN = _TWILIO_OPT_IN | {"COMENZAR", "INICIAR", "ALTA", "REANUDAR"}
_HELP = _TWILIO_HELP | {"AYUDA"}

_OPT_OUT_TYPE_MAP = {"STOP": KEYWORD_OPT_OUT, "START": KEYWORD_OPT_IN, "HELP": KEYWORD_HELP}

_URL_RE = re.compile(
    r"(?i)\b((?:https?://)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:/[^\s]*)?)"
)


# ---------------------------------------------------------------------------
# Message templates (Spanish, matching the registered campaign samples)
# ---------------------------------------------------------------------------

def brand() -> str:
    return settings.sms_brand_name


def auto_first_message(first_name: Optional[str], vehicle: Optional[str]) -> str:
    greeting = f"Hola, {first_name.strip()}." if first_name and first_name.strip() else "Hola."
    if vehicle and vehicle.strip():
        topic = f"Recibimos su consulta sobre el {vehicle.strip()}. ¿Qué le gustaría saber del vehículo?"
    else:
        topic = "Recibimos su consulta sobre su próximo vehículo. ¿En qué le podemos ayudar?"
    return f"{greeting} Somos {brand()}. {topic} Responda STOP para cancelar o HELP para obtener ayuda."


def promo_confirmation_message() -> str:
    return (
        f"{brand()}: Su suscripción a nuestras ofertas de vehículos está confirmada. "
        "La frecuencia de los mensajes puede variar. Pueden aplicarse tarifas de mensajes y datos. "
        "Responda HELP para obtener ayuda o STOP para cancelar."
    )


def opt_out_reply_es() -> str:
    return (
        f"{brand()}: Se ha dado de baja y no recibirá más mensajes. "
        "Responda START para volver a suscribirse."
    )


def help_reply_es() -> str:
    return (
        f"{brand()}: Para obtener ayuda visite {settings.sms_help_url} o responda a este mensaje. "
        "La frecuencia de los mensajes puede variar. Pueden aplicarse tarifas de mensajes y datos. "
        "Responda STOP para cancelar."
    )


# ---------------------------------------------------------------------------
# Keywords
# ---------------------------------------------------------------------------

def _normalize_keyword(body: str) -> str:
    text = unicodedata.normalize("NFKD", body or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^A-Za-z ]", "", text).strip().upper()
    return text


def classify_keyword(body: str, opt_out_type: Optional[str] = None) -> Tuple[Optional[str], bool]:
    """
    Returns (keyword kind, handled_by_twilio).
    Only a message that is exactly one keyword counts, so "stop by tomorrow?" is a normal reply.
    """
    if opt_out_type and opt_out_type.upper() in _OPT_OUT_TYPE_MAP:
        return _OPT_OUT_TYPE_MAP[opt_out_type.upper()], True
    word = _normalize_keyword(body)
    if not word or " " in word:
        return None, False
    if word in _OPT_OUT:
        return KEYWORD_OPT_OUT, word in _TWILIO_OPT_OUT
    if word in _OPT_IN:
        return KEYWORD_OPT_IN, word in _TWILIO_OPT_IN
    if word in _HELP:
        return KEYWORD_HELP, word in _TWILIO_HELP
    return None, False


def apply_inbound_keyword(
    customer: Optional[Customer], body: str, opt_out_type: Optional[str] = None
) -> Tuple[Optional[str], Optional[str]]:
    """
    Update the customer's consent for a keyword reply.
    Returns (keyword kind, reply text the CRM must send itself or None).
    """
    kind, handled_by_twilio = classify_keyword(body, opt_out_type)
    if kind is None:
        return None, None

    if kind == KEYWORD_OPT_OUT:
        if customer is not None:
            mark_opted_out(customer)
        return kind, None if handled_by_twilio else opt_out_reply_es()

    if kind == KEYWORD_OPT_IN:
        # "YES"/"SI" is also a normal answer to a question; it only re-subscribes someone who opted out.
        word = _normalize_keyword(body)
        if customer is not None and not customer.sms_opted_out and word == "YES" and not opt_out_type:
            return None, None
        if customer is not None:
            customer.sms_opted_out = False
            customer.sms_opted_out_at = None
            customer.sms_inquiry_consent = True
            customer.sms_promo_consent = True
            customer.sms_consent_source = "keyword_start"
            customer.sms_consent_at = utc_now()
            customer.sms_promo_confirmed_at = utc_now()
        return kind, None if handled_by_twilio else promo_confirmation_message()

    return kind, None if handled_by_twilio else help_reply_es()


def mark_opted_out(customer: Customer) -> None:
    if not customer.sms_opted_out:
        customer.sms_opted_out = True
        customer.sms_opted_out_at = utc_now()


def record_customer_initiated(customer: Customer) -> None:
    """A customer who texts us first may get replies to their conversation."""
    if customer.sms_inquiry_consent is None and not customer.sms_opted_out:
        customer.sms_inquiry_consent = True
        customer.sms_consent_source = "customer_texted_in"
        customer.sms_consent_at = utc_now()


def record_form_consent(customer: Customer, inquiry: bool, promo: bool, source: str) -> None:
    """Record the choices from a lead form submission (latest submission wins)."""
    customer.sms_inquiry_consent = inquiry
    customer.sms_promo_consent = promo
    customer.sms_consent_source = source[:50]
    customer.sms_consent_at = utc_now()


# ---------------------------------------------------------------------------
# Lead form consent columns
# ---------------------------------------------------------------------------

_CONSENT_HEADER_RE = re.compile(r"(?i)(sms|text|mensaje|consent|consentimiento|acepto|agree|autoriz)")
_PROMO_HEADER_RE = re.compile(r"(?i)(promo|oferta|offer|marketing|descuento|discount)")
_TRUTHY = {"true", "yes", "si", "sí", "1", "checked", "x", "y", "on", "agree", "acepto"}


def extract_consent_columns(row: Dict[str, str]) -> Dict[str, str]:
    return {k: v for k, v in row.items() if k and _CONSENT_HEADER_RE.search(k)}


def consent_from_columns(columns: Optional[Dict[str, str]]) -> Tuple[bool, bool, str]:
    """
    Returns (inquiry, promo, source). When the form export has no consent columns the
    owner has confirmed every lead form collects both consents, so both are granted.
    """
    if not columns:
        return True, True, "lead_form"
    inquiry = promo = False
    for header, value in columns.items():
        checked = (value or "").strip().lower() in _TRUTHY
        if _PROMO_HEADER_RE.search(header):
            promo = promo or checked
        else:
            inquiry = inquiry or checked
    return inquiry, promo, "lead_form_checkbox"


# ---------------------------------------------------------------------------
# Send rules
# ---------------------------------------------------------------------------

def send_block_reason(
    customer: Optional[Customer], category: str, promo_enabled: bool = False
) -> Optional[str]:
    """Why this text may not be sent, or None when it is allowed."""
    if category == CATEGORY_COMPLIANCE:
        return None
    if customer is not None and customer.sms_opted_out:
        return "This customer replied STOP. They can't be texted until they text START."
    if category == CATEGORY_PROMOTIONAL:
        if not promo_enabled:
            return "Promotional texts are turned off in Company Settings."
        if customer is None or customer.sms_promo_consent is not True:
            return "This customer hasn't agreed to promotional texts."
        return None
    if category == CATEGORY_AUTO_FIRST:
        if customer is None or customer.sms_inquiry_consent is not True:
            return "This customer hasn't agreed to texts."
        return None
    if customer is not None and customer.sms_inquiry_consent is False:
        return "This customer hasn't agreed to texts."
    return None


def link_hosts(body: str) -> Iterable[str]:
    for match in _URL_RE.findall(body or ""):
        url = match if "://" in match else f"https://{match}"
        host = (urlparse(url).hostname or "").lower()
        if host:
            yield host


def disallowed_link_hosts(body: str) -> list[str]:
    allowed = [d.strip().lower() for d in settings.sms_allowed_link_domains.split(",") if d.strip()]
    bad = []
    for host in link_hosts(body):
        if not any(host == d or host.endswith("." + d) for d in allowed):
            bad.append(host)
    return sorted(set(bad))


def prepare_promotional_body(body: str) -> str:
    """Promotional texts must name the brand and say how to opt out."""
    text = (body or "").strip()
    if brand().lower() not in text.lower():
        text = f"{brand()}: {text}"
    if "STOP" not in text.upper():
        text = f"{text} Responda STOP para cancelar."
    return text


def _format_money(val: object) -> str:
    if val is None or val == "":
        return ""
    try:
        num = float(val)
        return f"${num:,.0f}" if num.is_integer() else f"${num:,.2f}"
    except (ValueError, TypeError):
        return str(val).strip()


def personalize(
    body: str,
    first_name: Optional[str],
    *,
    last_name: Optional[str] = None,
    vehicle: Optional[str] = None,
    down_payment: object = None,
    agent_name: Optional[str] = None,
    dealership_name: Optional[str] = None,
    dealership_phone: Optional[str] = None,
    dealership_address: Optional[str] = None,
    inventory_url: Optional[str] = None,
) -> str:
    fname = (first_name or "").strip()
    lname = (last_name or "").strip()
    full_name = f"{fname} {lname}".strip()
    veh = (vehicle or "").strip()
    dp = _format_money(down_payment)
    agent = (agent_name or "").strip()
    store = (dealership_name or brand()).strip()
    phone = (dealership_phone or "").strip()
    addr = (dealership_address or "").strip()
    inv = (inventory_url or "carvamonos.com/inventario").strip()

    replacements = {
        "{nombre}": fname,
        "{Nombre}": fname,
        "[Nombre]": fname,
        "[nombre]": fname,
        "{name}": fname,
        "{first_name}": fname,
        "{apellido}": lname,
        "{last_name}": lname,
        "{nombre_completo}": full_name,
        "{full_name}": full_name,
        "{vehiculo}": veh,
        "{vehicle}": veh,
        "{enganche}": dp,
        "{down_payment}": dp,
        "{agente}": agent,
        "{agent}": agent,
        "{tienda}": store,
        "{dealership}": store,
        "{telefono_tienda}": phone,
        "{dealership_phone}": phone,
        "{direccion}": addr,
        "{address}": addr,
        "{inventario}": inv,
        "{inventory_link}": inv,
    }
    for token, value in replacements.items():
        if token in body:
            body = body.replace(token, value)
    return re.sub(r"\s{2,}", " ", body).replace(" ,", ",").strip()


def segment_count(body: str) -> int:
    """SMS segments: GSM-7 fits 160/153 chars, anything else (accents, emoji) 70/67."""
    gsm = set(
        "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡"
        "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€"
    )
    is_gsm = all(c in gsm for c in body)
    single, multi = (160, 153) if is_gsm else (70, 67)
    n = len(body)
    return 1 if n <= single else -(-n // multi)
