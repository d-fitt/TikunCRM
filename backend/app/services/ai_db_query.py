"""Read-only SQL for the assistant.

The model writes the query the way ChatGPT would, from the question and the
schema. This only runs a single SELECT and refuses writes and secrets.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

MAX_ROWS = 100

_BLOCKED_TABLES = (
    "dealership_twilio_configs",
    "dealership_email_configs",
    "fcm_tokens",
    "oauth_tokens",
    "password_reset_tokens",
    "partner_portal_users",
)

_WRITE_RE = re.compile(
    r"\b("
    r"insert|update|delete|drop|alter|truncate|grant|revoke|copy|create|"
    r"comment|vacuum|call|do|execute|merge|into|set|refresh|reindex|cluster|"
    r"lock|listen|notify|prepare"
    r")\b",
    re.I,
)
_SECRET_RE = re.compile(
    r"password|api_key|auth_token|secret|smtp_password|imap_password|credential",
    re.I,
)
_DANGEROUS_FN_RE = re.compile(
    r"\b(pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink)\b",
    re.I,
)

SCHEMA = """
PostgreSQL. The user asks in everyday language. You choose the date, the table, and the filters. They will not name columns or statuses.

Call query_database with ONE SELECT that returns every number the question needs (COUNT(*) FILTER or GROUP BY). Then answer from those rows. Do not invent a number. If the query errors, fix the SQL and call again. Never tell the user about SQL or the error.

Dates are timestamptz. A calendar day is (column AT TIME ZONE '<the timezone under Right now>')::date. Use the dates under Right now. Do not guess a year.
Compare every enum with column::text, using only the values below.

leads(id, customer_id, secondary_customer_id, stage_id, source, is_active, outcome, dealership_id, assigned_to, bdc_assigned_to_id, down_payment, has_ssn_stip, has_dl_stip, is_business, converted_at, created_at)
  outcome is 'converted', 'lost', or null. Converted leads are usually is_active = false. Do not add is_active = true when counting conversions.
  source::text is GOOGLE_SHEETS, META_ADS, MANUAL, WEBSITE, REFERRAL, WALK_IN, whatsapp_inbound, sms_inbound, WHATSAPP_INBOUND.
customers(id, first_name, last_name, phone, email, postal_code, city, state, credit_score, has_license)
lead_stip_documents(id, lead_id, stips_category_id, file_name, uploaded_at)
customer_stip_documents(id, customer_id, stips_category_id, file_name, uploaded_at)
  A document was uploaded only when a row exists in one of those tables, for the lead or for its customer (customer_id or secondary_customer_id). has_ssn_stip and has_dl_stip can be true with no file.
lead_stages(id, name, display_name)
appointments(id, lead_id, scheduled_at, status, appointment_type, completed_at)
  status::text is scheduled, confirmed, arrived, in_showroom, in_progress, completed, cancelled, no_show, rescheduled, sold.
  appointment_type::text is phone_call, email, in_person, video_call, other.
  "How many appointments" means every appointment that day unless they name a status. Return the total and each status in the same SELECT. There is no check-in status.
showroom_visits(id, lead_id, appointment_id, checked_in_at, checked_out_at, outcome)
  A check-in is a row here. Count it with checked_in_at.
  Use lower(outcome::text) in sold, not_interested, follow_up, reschedule, browsing, couldnt_qualify.
call_logs(id, lead_id, customer_id, user_id, direction, status, created_at, duration)
  direction::text is inbound or outbound.
  status::text is initiated, ringing, in-progress, completed, busy, no-answer, failed, canceled.
activities(id, lead_id, user_id, type, description, created_at)
  type::text examples: NOTE_ADDED, CALL_LOGGED, SMS_SENT, SMS_RECEIVED, EMAIL_SENT, EMAIL_RECEIVED, WHATSAPP_SENT, WHATSAPP_RECEIVED, APPOINTMENT_SCHEDULED, APPOINTMENT_COMPLETED.
follow_ups(id, lead_id, assigned_to, scheduled_at, status, notes)
  status::text is PENDING, COMPLETED, MISSED, CANCELLED.
users(id, first_name, last_name, email, role, is_active, dealership_id)
  role::text is BDC, SALESPERSON, DEALERSHIP_ADMIN, DEALERSHIP_OWNER, SUPER_ADMIN.
partner_stores(id, name, brand, city, state, postal_code, address)
dealerships(id, name, slug)
""".strip()


def business_clock(tz_name: str, now: Optional[datetime] = None) -> str:
    """Dates the assistant must use, so 'last Saturday' is never a guessed year."""
    tz = ZoneInfo(tz_name)
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    local = moment.astimezone(tz)
    today = local.date()
    days_since_saturday = (today.weekday() - 5) % 7
    last_saturday = today - timedelta(days=days_since_saturday)
    yesterday = today - timedelta(days=1)
    week_start = today - timedelta(days=today.weekday())
    week_end = week_start + timedelta(days=6)
    hour = local.hour % 12 or 12
    ampm = "AM" if local.hour < 12 else "PM"
    saturday_line = (
        f"Today is Saturday ({today.isoformat()}). The Saturday before was "
        f"{(today - timedelta(days=7)).isoformat()}."
        if days_since_saturday == 0
        else f"Last Saturday was {last_saturday.isoformat()}."
    )
    return (
        f"Today is {local.strftime('%A')}, {local.strftime('%B')} {today.day}, {today.year} "
        f"({today.isoformat()}) in {tz_name}. Local time is {hour}:{local.strftime('%M')} {ampm}.\n"
        f"Yesterday was {yesterday.isoformat()} ({yesterday.strftime('%A')}).\n"
        f"{saturday_line}\n"
        f"This week is {week_start.isoformat()} through {week_end.isoformat()}.\n"
        f"Last week was {(week_start - timedelta(days=7)).isoformat()} through "
        f"{(week_start - timedelta(days=1)).isoformat()}.\n"
        f"This month starts {today.replace(day=1).isoformat()}.\n"
        f"Filter a calendar day with (column AT TIME ZONE '{tz_name}')::date. Use these dates."
    )


def _error_hint(message: str) -> str:
    low = message.lower()
    if "enum" in low or "invalid input value" in low:
        return (
            " Compare enums with column::text. "
            "appointments.status: scheduled, confirmed, arrived, in_showroom, in_progress, "
            "completed, cancelled, no_show, rescheduled, sold. "
            "Check-ins are showroom_visits.checked_in_at, not an appointment status. "
            "showroom outcome: lower(outcome::text). "
            "follow_ups.status: PENDING, COMPLETED, MISSED, CANCELLED. "
            "call_logs.direction: inbound, outbound. "
            "call_logs.status: completed, no-answer, busy, failed, canceled, in-progress."
        )
    if "does not exist" in low or "undefinedcolumn" in low:
        return " Use only columns listed in the schema."
    return ""


class QueryRejected(Exception):
    pass


def _strip_comments(sql: str) -> str:
    without_block = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    return re.sub(r"--[^\n]*", " ", without_block)


def validate_select(sql: str) -> str:
    raw = (sql or "").strip()
    if not raw:
        raise QueryRejected("Write a SELECT query.")
    statement = raw.rstrip(";").strip()
    if ";" in statement:
        raise QueryRejected("Send one SELECT at a time.")
    visible = _strip_comments(statement)
    if not re.match(r"(?is)^(select|with)\b", visible):
        raise QueryRejected("Only a SELECT query can run.")
    if _WRITE_RE.search(visible):
        raise QueryRejected("Only a read query can run.")
    if _SECRET_RE.search(visible) or _DANGEROUS_FN_RE.search(visible):
        raise QueryRejected("That query asks for secrets. Leave passwords and tokens out.")
    for table in _BLOCKED_TABLES:
        if re.search(rf"\b{table}\b", visible, re.I):
            raise QueryRejected(f"{table} is not available to the assistant.")
    return statement


def _cell(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (bytes, memoryview)):
        return None
    if isinstance(value, str) and len(value) > 400:
        return value[:400] + "…"
    return value


async def run_select(db: AsyncSession, sql: str) -> Dict[str, Any]:
    try:
        statement = validate_select(sql)
    except QueryRejected as exc:
        return {"error": str(exc), "sql": sql}

    wrapped = f"SELECT * FROM ({statement}) AS ai_query LIMIT {MAX_ROWS + 1}"
    try:
        async with db.begin_nested():
            await db.execute(text("SET LOCAL statement_timeout = '8s'"))
            result = await db.execute(text(wrapped.replace("%", "%%")))
            mappings = result.mappings().fetchall()
    except Exception as exc:
        message = str(getattr(exc, "orig", None) or exc)
        return {"error": message + _error_hint(message), "sql": statement}

    truncated = len(mappings) > MAX_ROWS
    kept = mappings[:MAX_ROWS]
    rows: List[Dict[str, Any]] = [
        {key: _cell(value) for key, value in row.items()} for row in kept
    ]
    columns = list(rows[0].keys()) if rows else []
    return {
        "sql": statement,
        "columns": columns,
        "row_count": len(rows),
        "truncated": truncated,
        "rows": rows,
    }
