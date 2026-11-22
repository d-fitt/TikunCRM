"""Answer CRM count, percentage, and average questions from the database.

The assistant used to search notes or return a short lead list. Questions like
"what percent of customers with a stip uploaded have converted" need two
counts over the same leads the user is allowed to see, including converted
leads (those rows are inactive).
"""
from __future__ import annotations

import re
from datetime import timedelta
from typing import Any, Dict, List, Optional
from uuid import UUID

from sqlalchemy import String, cast, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.access_scope import get_accessible_dealership_ids
from app.core.permissions import UserRole
from app.core.timezone import utc_now
from app.models.customer_stip_document import CustomerStipDocument
from app.models.lead import Lead
from app.models.lead_stage import LeadStage
from app.models.lead_stip_document import LeadStipDocument
from app.models.user import User

_STATS_RE = re.compile(
    r"\b("
    r"percent|percentage|what share|what portion|conversion rate|"
    r"how many|how much|number of|count of|"
    r"average|avg|mean"
    r")\b",
    re.I,
)

_FILTER_KEYS = (
    "has_stip",
    "has_ssn_stip",
    "has_dl_stip",
    "outcome",
    "is_active",
    "is_business",
    "source",
    "stage",
    "created_within_days",
    "pool",
    "down_min",
    "down_max",
)


def looks_like_crm_stat(text: str) -> bool:
    """True when the question needs a count or percentage, not a note search."""
    return bool(_STATS_RE.search(text or ""))


def clean_filters(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    cleaned: Dict[str, Any] = {}
    for key in _FILTER_KEYS:
        if key not in raw or raw[key] is None or raw[key] == "":
            continue
        value = raw[key]
        if key in {"has_stip", "has_ssn_stip", "has_dl_stip", "is_active", "is_business"}:
            coerced = _as_bool(value)
            if coerced is None:
                continue
            value = coerced
        elif key == "created_within_days":
            try:
                value = max(1, int(value))
            except (TypeError, ValueError):
                continue
        elif key in {"down_min", "down_max"}:
            try:
                value = float(value)
            except (TypeError, ValueError):
                continue
        elif key == "outcome":
            value = str(value).strip().lower()
            if value in {"sold", "sale", "won"}:
                value = "converted"
            if value not in {"converted", "lost", "open"}:
                continue
        elif key == "pool":
            value = str(value).strip().lower()
            if value not in {"mine", "unassigned", "all"}:
                continue
        else:
            value = str(value).strip()
            if not value:
                continue
        cleaned[key] = value
    return cleaned


def describe_filters(filters: Dict[str, Any]) -> str:
    bits: List[str] = []
    if filters.get("has_stip") is True:
        bits.append("a stip uploaded")
    elif filters.get("has_stip") is False:
        bits.append("no stip uploaded")
    if filters.get("has_ssn_stip") is True:
        bits.append("an SSN stip")
    if filters.get("has_dl_stip") is True:
        bits.append("a driver-license stip")
    outcome = filters.get("outcome")
    if outcome == "converted":
        bits.append("converted")
    elif outcome == "lost":
        bits.append("lost")
    elif outcome == "open":
        bits.append("still open")
    if filters.get("is_business") is True:
        bits.append("a business")
    elif filters.get("is_business") is False:
        bits.append("not a business")
    if filters.get("source"):
        bits.append(f"source {filters['source']}")
    if filters.get("stage"):
        bits.append(f"stage {filters['stage']}")
    if filters.get("created_within_days"):
        bits.append(f"created in the last {filters['created_within_days']} days")
    if filters.get("down_min") is not None:
        bits.append(f"down payment at least {filters['down_min']}")
    if filters.get("down_max") is not None:
        bits.append(f"down payment at most {filters['down_max']}")
    if filters.get("pool") == "mine":
        bits.append("assigned to you")
    elif filters.get("pool") == "unassigned":
        bits.append("unassigned")
    return ", ".join(bits) if bits else "no extra filters"


def percentage_answer(
    numerator: int,
    denominator: int,
    numerator_filters: Dict[str, Any],
    denominator_filters: Dict[str, Any],
) -> Dict[str, Any]:
    if denominator <= 0:
        pct = None
        answer = (
            f"0 leads match the comparison group ({describe_filters(denominator_filters)}), "
            "so there is no percentage."
        )
    else:
        pct = round(1000 * numerator / denominator) / 10
        extra = {
            key: value
            for key, value in numerator_filters.items()
            if denominator_filters.get(key) != value
        }
        group = describe_filters(denominator_filters)
        if extra == {"outcome": "converted"}:
            answer = f"{numerator} of {denominator} leads with {group} are converted ({pct}%)."
        elif extra == {"outcome": "lost"}:
            answer = f"{numerator} of {denominator} leads with {group} are lost ({pct}%)."
        else:
            answer = (
                f"{numerator} of {denominator} leads ({pct}%). "
                f"That is {describe_filters(numerator_filters)} "
                f"out of {group}."
            )
    return {
        "numerator": numerator,
        "denominator": denominator,
        "percentage": pct,
        "answer": answer,
    }


def _as_bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "1"}:
            return True
        if lowered in {"false", "no", "0"}:
            return False
    return None


def _has_stip_clause():
    lead_doc = exists(
        select(LeadStipDocument.id).where(LeadStipDocument.lead_id == Lead.id)
    )
    customer_doc = exists(
        select(CustomerStipDocument.id).where(
            or_(
                CustomerStipDocument.customer_id == Lead.customer_id,
                CustomerStipDocument.customer_id == Lead.secondary_customer_id,
            )
        )
    )
    return or_(
        Lead.has_ssn_stip.is_(True),
        Lead.has_dl_stip.is_(True),
        lead_doc,
        customer_doc,
    )


def _apply_stat_filters(query, filters: Dict[str, Any]):
    if filters.get("has_stip") is True:
        query = query.where(_has_stip_clause())
    elif filters.get("has_stip") is False:
        query = query.where(~_has_stip_clause())

    outcome = filters.get("outcome")
    if outcome == "converted":
        query = query.where(Lead.outcome == "converted")
    elif outcome == "lost":
        query = query.where(Lead.outcome == "lost")
    elif outcome == "open":
        query = query.where(
            or_(Lead.outcome.is_(None), Lead.outcome.notin_(["converted", "lost"]))
        )

    if filters.get("stage"):
        stage = f"%{filters['stage']}%"
        stage_ids = select(LeadStage.id).where(
            or_(LeadStage.name.ilike(stage), LeadStage.display_name.ilike(stage))
        )
        query = query.where(Lead.stage_id.in_(stage_ids))

    if filters.get("source"):
        query = query.where(cast(Lead.source, String).ilike(f"%{filters['source']}%"))

    days = filters.get("created_within_days")
    if days:
        query = query.where(Lead.created_at >= utc_now() - timedelta(days=int(days)))

    return query


async def _scoped_query(db: AsyncSession, user: User, filters: Dict[str, Any]):
    from app.api.v1.endpoints.leads import _build_leads_list_select

    accessible = await get_accessible_dealership_ids(db, user)
    pool = filters.get("pool")
    if pool == "all":
        pool = None
    elif pool is None and user.role == UserRole.SALESPERSON:
        pool = "mine"

    query = _build_leads_list_select(
        user,
        accessible,
        pool=pool,
        is_active=filters.get("is_active"),
        down_min=filters.get("down_min"),
        down_max=filters.get("down_max"),
        has_ssn_stip=filters.get("has_ssn_stip"),
        has_dl_stip=filters.get("has_dl_stip"),
        is_business=filters.get("is_business"),
    )
    return _apply_stat_filters(query, filters), pool


async def _count(db: AsyncSession, query) -> int:
    distinct_ids = query.with_only_columns(Lead.id).distinct().order_by(None).subquery()
    result = await db.execute(select(func.count()).select_from(distinct_ids))
    return int(result.scalar() or 0)


async def run_crm_stats(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    """Count, percentage, average, or grouped counts. Read-only and access-scoped."""
    numerator_filters = clean_filters(args.get("numerator") or args.get("numerator_filters"))
    denominator_filters = clean_filters(args.get("denominator") or args.get("denominator_filters"))
    single_filters = clean_filters(args.get("filters"))
    raw_counts = args.get("counts") if isinstance(args.get("counts"), list) else []

    if not numerator_filters and not denominator_filters and not single_filters and not raw_counts:
        if not args.get("group_by") and not args.get("average"):
            return {
                "error": (
                    "Say which leads to count. For a percentage, set numerator and "
                    "denominator filters. Example: numerator {has_stip: true, outcome: "
                    "converted} and denominator {has_stip: true}."
                )
            }

    scope_bits: List[str] = []
    payload: Dict[str, Any] = {"counts": []}

    async def one_count(name: str, filters: Dict[str, Any]) -> int:
        query, pool = await _scoped_query(db, user, filters)
        counted = await _count(db, query)
        if pool == "mine":
            scope_bits.append("your assigned leads")
        elif pool == "unassigned":
            scope_bits.append("unassigned leads")
        else:
            scope_bits.append("every lead you can see, including converted leads")
        payload["counts"].append(
            {"name": name, "count": counted, "filters": describe_filters(filters)}
        )
        return counted

    if numerator_filters or denominator_filters:
        if not denominator_filters:
            denominator_filters = {
                key: value
                for key, value in numerator_filters.items()
                if key != "outcome"
            }
        num = await one_count("numerator", numerator_filters)
        den = await one_count("denominator", denominator_filters)
        payload.update(
            percentage_answer(num, den, numerator_filters, denominator_filters)
        )

    for item in raw_counts[:8]:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "count").strip() or "count"
        filters = clean_filters(item.get("filters") or item)
        await one_count(name, filters)

    if single_filters and not (numerator_filters or denominator_filters):
        counted = await one_count("matched", single_filters)
        payload["count"] = counted
        payload["answer"] = (
            f"{counted} leads match {describe_filters(single_filters)}."
        )

    group_by = str(args.get("group_by") or "").strip().lower()
    if group_by in {"source", "outcome", "stage"}:
        filters = single_filters or denominator_filters or numerator_filters
        query, pool = await _scoped_query(db, user, filters)
        if pool == "mine":
            scope_bits.append("your assigned leads")
        payload["groups"] = await _group_counts(db, query, group_by)
        payload["group_by"] = group_by

    average = str(args.get("average") or "").strip().lower()
    if average == "down_payment":
        filters = single_filters or numerator_filters
        query, _pool = await _scoped_query(db, user, filters)
        query = query.where(Lead.down_payment.isnot(None))
        distinct_ids = query.with_only_columns(Lead.id).distinct().order_by(None).subquery()
        avg_row = (
            await db.execute(
                select(func.avg(Lead.down_payment), func.count(Lead.id)).where(
                    Lead.id.in_(select(distinct_ids.c.id))
                )
            )
        ).one()
        avg_value = float(avg_row[0]) if avg_row[0] is not None else None
        payload["average"] = {
            "field": "down_payment",
            "value": round(avg_value, 2) if avg_value is not None else None,
            "count": int(avg_row[1] or 0),
        }
        if avg_value is None:
            payload["answer"] = "No leads in that group have a down payment."
        else:
            payload["answer"] = (
                f"Average down payment is ${avg_value:,.0f} "
                f"across {int(avg_row[1] or 0)} leads "
                f"({describe_filters(filters)})."
            )

    payload["scope"] = scope_bits[0] if scope_bits else "every lead you can see"
    if "answer" not in payload and payload["counts"]:
        parts = [f"{row['name']}: {row['count']} ({row['filters']})" for row in payload["counts"]]
        payload["answer"] = "; ".join(parts) + "."
    return payload


async def _group_counts(db: AsyncSession, query, group_by: str) -> List[Dict[str, Any]]:
    distinct_ids = query.with_only_columns(Lead.id).distinct().order_by(None).subquery()
    base = select(Lead).where(Lead.id.in_(select(distinct_ids.c.id)))
    if group_by == "source":
        label = cast(Lead.source, String)
        grouped = (
            base.with_only_columns(label, func.count(Lead.id))
            .group_by(label)
            .order_by(func.count(Lead.id).desc())
            .limit(12)
        )
    elif group_by == "outcome":
        label = func.coalesce(Lead.outcome, "open")
        grouped = (
            base.with_only_columns(label, func.count(Lead.id))
            .group_by(label)
            .order_by(func.count(Lead.id).desc())
            .limit(12)
        )
    else:
        grouped = (
            base.join(LeadStage, LeadStage.id == Lead.stage_id)
            .with_only_columns(func.coalesce(LeadStage.display_name, LeadStage.name), func.count(Lead.id))
            .group_by(LeadStage.display_name, LeadStage.name)
            .order_by(func.count(Lead.id).desc())
            .limit(12)
        )
    rows = (await db.execute(grouped)).all()
    return [{"label": str(row[0] or "unknown"), "count": int(row[1] or 0)} for row in rows]
