"""Read-only SQL for the assistant.

The model writes the query the way ChatGPT would, from the question and the
schema. This only runs a single SELECT and refuses writes and secrets.
"""
from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List
from uuid import UUID

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
PostgreSQL. Call query_database with one SELECT. Call it again if you need another number or the error shows a bad column. Then answer in plain language from the rows. Do not invent a number the query did not return.

leads(id, customer_id, secondary_customer_id, stage_id, source, is_active, outcome, dealership_id, assigned_to, bdc_assigned_to_id, down_payment, has_ssn_stip, has_dl_stip, is_business, converted_at, created_at)
  outcome is 'converted', 'lost', or null. Converted leads are usually is_active = false, so do not add is_active = true when counting conversions.
  source is an enum. Compare with source::text.
customers(id, first_name, last_name, phone, email, postal_code, city, state, credit_score, has_license)
lead_stip_documents(id, lead_id, stips_category_id, file_name, uploaded_at)
customer_stip_documents(id, customer_id, stips_category_id, file_name, uploaded_at)
  A stip was uploaded when a row exists in either stip table for that lead or its customer (customer_id or secondary_customer_id), or leads.has_ssn_stip / has_dl_stip is true.
lead_stages(id, name, display_name)
appointments(id, lead_id, scheduled_at, status, appointment_type)
call_logs(id, lead_id, customer_id, user_id, direction, status, created_at, duration)
  direction::text is INBOUND or OUTBOUND. status::text is COMPLETED, NO_ANSWER, and the other Twilio names.
activities(id, lead_id, user_id, type, description, created_at)
follow_ups(id, lead_id, assigned_to, scheduled_at, status, notes)
users(id, first_name, last_name, email, role, is_active, dealership_id)
  role::text is BDC, SALESPERSON, DEALERSHIP_ADMIN, DEALERSHIP_OWNER, SUPER_ADMIN.
partner_stores(id, name, brand, city, state, postal_code, address)
dealerships(id, name, slug)
""".strip()


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
        return {"error": message, "sql": statement}

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
