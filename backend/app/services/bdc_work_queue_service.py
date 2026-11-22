"""
Ranked Call next list for a BDC agent.

Notes, calls, follow-ups, and appointments are gathered first.
Tikun AI then orders who to call, using those notes. If the model is
unavailable, the rules order is used.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence
from uuid import UUID

import pytz
from sqlalchemy import desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.access_scope import get_accessible_dealership_ids
from app.core.timezone import utc_now
from app.models.activity import Activity, ActivityType
from app.models.appointment import Appointment, AppointmentStatus
from app.models.call_log import CallDirection, CallLog, CallStatus
from app.models.follow_up import FollowUp, FollowUpStatus
from app.models.lead import Lead
from app.services.activity import ActivityService

logger = logging.getLogger(__name__)

QUEUE_LIMIT = 25
BUCKET_LIMIT = 60
NOTE_PREVIEW_LIMIT = 180
BOOST = 40
COOLDOWN_SECONDS = 2 * 60 * 60
QUIET_DAYS = 3
MISSED_LOOKBACK_DAYS = 14

BAND_CONFIRM_SOON = "confirm_soon"
BAND_MISSED = "missed_inbound"
BAND_OVERDUE = "overdue_follow_up"
BAND_CONFIRM_TODAY = "confirm_today"
BAND_DUE_TODAY = "due_today"
BAND_FRESH = "fresh"
BAND_RETRY = "retry"
BAND_BOOK = "book"
BAND_QUIET = "quiet"
BAND_COOLDOWN = "cooldown"
BAND_DNC = "do_not_call"

_SINK = re.compile(
    r"\b(do not call|don't call|dont call|dnc|wrong number|not interested)\b",
    re.IGNORECASE,
)
_BOOST = re.compile(
    r"\b(call\s*back|callback|asap|waiting|hot|ready|coming in)\b",
    re.IGNORECASE,
)
_SPANISH = re.compile(r"\bspanish\b", re.IGNORECASE)
_TEXT_ONLY = re.compile(r"\btext only\b", re.IGNORECASE)

_UNSUCCESSFUL_OUTCOMES = {
    "no-answer",
    "no_answer",
    "no answer",
    "busy",
    "failed",
    "canceled",
    "cancelled",
    "voicemail",
    "missed",
}
_UNSUCCESSFUL_STATUSES = {"no-answer", "busy", "failed", "canceled"}
_OUTCOME_LABELS = {
    "no-answer": "No answer",
    "no_answer": "No answer",
    "no answer": "No answer",
    "busy": "Busy",
    "failed": "Failed",
    "canceled": "Canceled",
    "cancelled": "Canceled",
    "voicemail": "Voicemail",
    "missed": "Missed call",
    "spoke": "Spoke",
    "completed": "Completed",
    "not interested": "Not interested",
}

DISPOSITIONS = {
    "no_answer": {
        "outcome": "no-answer",
        "note": "No answer",
        "follow_up": "retry",
        "write_note": False,
    },
    "voicemail": {
        "outcome": "voicemail",
        "note": "Left voicemail",
        "follow_up": "retry",
        "write_note": False,
    },
    "spoke": {
        "outcome": "spoke",
        "note": "Spoke with customer",
        "follow_up": "tomorrow",
        "write_note": False,
    },
    "not_now": {
        "outcome": "not interested",
        "note": "Not interested — not now",
        "follow_up": None,
        "write_note": True,
    },
}


class WorkQueueError(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


@dataclass
class QueueSignals:
    created_at: datetime
    first_contacted_at: Optional[datetime] = None
    last_contacted_at: Optional[datetime] = None
    last_activity_at: Optional[datetime] = None
    last_inbound_at: Optional[datetime] = None
    summary_notes: str = ""
    latest_note: str = ""
    overdue_at: Optional[datetime] = None
    due_today_at: Optional[datetime] = None
    has_future_follow_up: bool = False
    appointment_soon_at: Optional[datetime] = None
    appointment_soon_confirmed: bool = False
    appointment_today_at: Optional[datetime] = None
    has_upcoming_appointment: bool = False
    last_unsuccessful_at: Optional[datetime] = None
    unanswered_inbound_at: Optional[datetime] = None
    last_outcome: Optional[str] = None
    attempts_today: int = 0
    extras: Dict[str, Any] = field(default_factory=dict)


def zone(name: Optional[str]):
    raw = (name or "").strip() or "America/New_York"
    try:
        return pytz.timezone(raw)
    except pytz.UnknownTimeZoneError:
        return pytz.timezone("America/New_York")


def day_bounds(now: datetime, tz_name: Optional[str]) -> tuple[datetime, datetime]:
    local = _utc(now).astimezone(zone(tz_name))
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return start.astimezone(pytz.UTC), end.astimezone(pytz.UTC)


def next_touch_at(now: datetime, tz_name: Optional[str], kind: str) -> datetime:
    """Retry is two hours out, or 9:00 next morning after 6pm. Spoke is always next morning."""
    local = _utc(now).astimezone(zone(tz_name))
    if kind == "tomorrow" or local.hour >= 18:
        nxt = (local + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
        return nxt.astimezone(pytz.UTC)
    return _utc(now) + timedelta(hours=2)


def _utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _enum_val(value: Any) -> str:
    if value is None:
        return ""
    raw = value.value if hasattr(value, "value") else value
    return str(raw).strip().lower()


def _preview(text: str) -> Optional[str]:
    cleaned = " ".join((text or "").split())
    if not cleaned:
        return None
    if len(cleaned) <= NOTE_PREVIEW_LIMIT:
        return cleaned
    return cleaned[: NOTE_PREVIEW_LIMIT - 1].rstrip() + "…"


def _ago(dt: datetime, now: datetime) -> str:
    seconds = (_utc(now) - _utc(dt)).total_seconds()
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{int(seconds // 60)}m ago"
    if seconds < 86400:
        return f"{int(seconds // 3600)}h ago"
    return f"{int(seconds // 86400)}d ago"


def _in_minutes(dt: datetime, now: datetime) -> int:
    return int((_utc(dt) - _utc(now)).total_seconds() // 60)


def _when_upcoming(dt: datetime, now: datetime) -> str:
    mins = _in_minutes(dt, now)
    if mins <= 5:
        return "now"
    if mins < 120:
        return f"in {mins} min"
    return "today"


def _note_bits(signals: QueueSignals) -> tuple[str, List[str], bool, int]:
    """Latest timeline note wins. The lead summary is used only when she has not written one."""
    latest = (signals.latest_note or "").strip()
    summary = (signals.summary_notes or "").strip()
    primary = latest or summary
    combined = f"{summary}\n{latest}"
    chips: List[str] = []
    if _SPANISH.search(combined):
        chips.append("Spanish")
    if _TEXT_ONLY.search(combined):
        chips.append("Text only")
    sink = _SINK.search(primary) is not None
    if sink:
        chips.append("Do not call")
    boost = 0 if sink else (BOOST if _BOOST.search(primary) else 0)
    return primary, chips, sink, boost


def _row(
    *,
    band: str,
    score: int,
    tie: float,
    reason: str,
    action: str,
    signals: QueueSignals,
    chips: List[str],
) -> Dict[str, Any]:
    preview_source = signals.latest_note or signals.summary_notes or ""
    return {
        "priority_band": band,
        "priority_score": score,
        "tie": tie,
        "reason": reason,
        "action": action,
        "note_preview": _preview(preview_source),
        "chips": chips,
        "last_outcome": signals.last_outcome,
        "attempts_today": signals.attempts_today,
    }


def score_work_item(signals: QueueSignals, now: datetime) -> Optional[Dict[str, Any]]:
    """Pick the highest band. A recent no-answer and a do-not-call note override it."""
    now = _utc(now)
    _, chips, sink, boost = _note_bits(signals)
    created = _utc(signals.created_at) or now

    if sink:
        return _row(
            band=BAND_DNC,
            score=0,
            tie=created.timestamp(),
            reason="Do not call",
            action="call",
            signals=signals,
            chips=chips,
        )

    unsuccessful_at = _utc(signals.last_unsuccessful_at)
    inbound_at = _utc(signals.unanswered_inbound_at)
    contacted_at = _utc(signals.last_contacted_at)
    if inbound_at is not None and contacted_at is not None and contacted_at >= inbound_at:
        inbound_at = None
    resubmit_at = _utc(signals.last_inbound_at)
    soon_at = _utc(signals.appointment_soon_at)
    if unsuccessful_at is not None:
        age = (now - unsuccessful_at).total_seconds()
        newer_inbound = inbound_at is not None and inbound_at > unsuccessful_at
        newer_inquiry = resubmit_at is not None and resubmit_at > unsuccessful_at
        if (
            age < COOLDOWN_SECONDS
            and not newer_inbound
            and not newer_inquiry
            and soon_at is None
        ):
            return _row(
                band=BAND_COOLDOWN,
                score=20,
                tie=unsuccessful_at.timestamp(),
                reason="Called recently — wait before redial",
                action="call",
                signals=signals,
                chips=chips,
            )

    options: List[tuple] = []

    if soon_at is not None:
        confirmed = signals.appointment_soon_confirmed
        when = _when_upcoming(soon_at, now)
        label = "confirmed" if confirmed else "not confirmed"
        options.append(
            (
                780 if confirmed else 800,
                BAND_CONFIRM_SOON,
                soon_at.timestamp(),
                f"Appointment {when} — {label}",
                "confirm",
            )
        )

    if inbound_at is not None or (
        resubmit_at is not None
        and (_utc(signals.last_contacted_at) is None or resubmit_at > _utc(signals.last_contacted_at))
    ):
        if inbound_at is not None:
            reason = "Missed call — not returned"
            tie = inbound_at.timestamp()
        else:
            reason = "New inquiry — not called back"
            tie = resubmit_at.timestamp()
        options.append((700, BAND_MISSED, tie, reason, "call"))

    overdue_at = _utc(signals.overdue_at)
    if overdue_at is not None and overdue_at < now:
        options.append(
            (
                600,
                BAND_OVERDUE,
                overdue_at.timestamp(),
                f"Overdue follow-up · due {_ago(overdue_at, now)}",
                "call",
            )
        )

    later_at = _utc(signals.appointment_today_at)
    if later_at is not None:
        options.append(
            (
                550,
                BAND_CONFIRM_TODAY,
                later_at.timestamp(),
                "Appointment today — not confirmed",
                "confirm",
            )
        )

    due_at = _utc(signals.due_today_at)
    if due_at is not None and due_at >= now:
        mins = _in_minutes(due_at, now)
        if mins <= 0:
            due_reason = "Follow-up due now"
        elif mins < 180:
            due_reason = f"Follow-up due in {mins} min"
        else:
            due_reason = "Follow-up due today"
        options.append((500, BAND_DUE_TODAY, due_at.timestamp(), due_reason, "call"))

    contacted = _utc(signals.first_contacted_at) or _utc(signals.last_contacted_at)
    if contacted is None:
        options.append(
            (
                400,
                BAND_FRESH,
                -created.timestamp(),
                "Fresh lead — no call yet",
                "call",
            )
        )

    if unsuccessful_at is not None and (now - unsuccessful_at).total_seconds() >= COOLDOWN_SECONDS:
        tries = signals.attempts_today
        if tries == 1:
            retry_reason = "No answer · 1 try today"
        elif tries > 1:
            retry_reason = f"No answer · {tries} tries today"
        else:
            retry_reason = "No answer · try again"
        options.append((300, BAND_RETRY, unsuccessful_at.timestamp(), retry_reason, "call"))

    last_touch = _utc(signals.last_activity_at) or contacted
    open_work = (
        signals.has_upcoming_appointment
        or signals.has_future_follow_up
        or overdue_at is not None
        or (due_at is not None and due_at >= now)
    )
    if contacted is not None and not open_work and last_touch is not None:
        stale = (now - last_touch).total_seconds() >= QUIET_DAYS * 86400
        if not stale:
            options.append(
                (
                    200,
                    BAND_BOOK,
                    last_touch.timestamp(),
                    "Contacted — no appointment yet",
                    "book",
                )
            )
        else:
            options.append(
                (
                    100,
                    BAND_QUIET,
                    last_touch.timestamp(),
                    "No activity in 3 days",
                    "call",
                )
            )

    if not options:
        return None

    score, band, tie, reason, action = max(options, key=lambda item: item[0])
    return _row(
        band=band,
        score=score + boost,
        tie=tie,
        reason=reason,
        action=action,
        signals=signals,
        chips=chips,
    )


def _base_clauses(user_id: UUID, accessible_ids: Optional[Sequence[UUID]], dealership_id: Optional[UUID]):
    clauses = [
        Lead.is_active.is_(True),
        or_(Lead.outcome.is_(None), Lead.outcome.notin_(("converted", "lost"))),
        or_(Lead.bdc_assigned_to_id == user_id, Lead.bdc_assigned_to_id.is_(None)),
    ]
    if accessible_ids is not None:
        if not accessible_ids:
            clauses.append(Lead.id.is_(None))
        else:
            clauses.append(Lead.dealership_id.in_(list(accessible_ids)))
    if dealership_id is not None:
        clauses.append(Lead.dealership_id == dealership_id)
    return clauses


async def _lead_ids(db: AsyncSession, stmt, limit: int) -> List[UUID]:
    rows = (await db.execute(stmt.limit(limit))).all()
    found: List[UUID] = []
    seen = set()
    for row in rows:
        lead_id = row[0]
        if lead_id and lead_id not in seen:
            seen.add(lead_id)
            found.append(lead_id)
    return found


def _is_unsuccessful(outcome: str, status: str) -> bool:
    if outcome in _UNSUCCESSFUL_OUTCOMES:
        return True
    if status in _UNSUCCESSFUL_STATUSES and outcome not in {
        "spoke",
        "interested",
        "connected",
        "completed",
        "answered",
    }:
        return True
    return False


def _is_missed_inbound(outcome: str, status: str) -> bool:
    if outcome in {"missed", "voicemail"}:
        return True
    return status in _UNSUCCESSFUL_STATUSES


def _outcome_label(outcome: str, status: str) -> Optional[str]:
    raw = outcome or status
    if not raw:
        return None
    return _OUTCOME_LABELS.get(raw, raw.replace("_", " ").replace("-", " ").title())


def _note_body(meta: Any) -> str:
    if not isinstance(meta, dict):
        return ""
    return str(meta.get("content") or meta.get("notes") or "").strip()


@dataclass
class WorkQueueResult:
    items: List[Dict[str, Any]]
    ranked_by: str = "rules"


def apply_ai_order(rows: List[Dict[str, Any]], ordered: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Apply the model order. Do-not-call stays at the bottom even if the model promotes it."""
    by_id = {str(row["lead_id"]): row for row in rows}
    used = set()
    result: List[Dict[str, Any]] = []
    for item in ordered:
        if not isinstance(item, dict):
            continue
        lead_id = str(item.get("lead_id") or "")
        row = by_id.get(lead_id)
        if row is None or lead_id in used or row.get("priority_band") == BAND_DNC:
            continue
        reason = str(item.get("reason") or "").strip()
        if reason:
            row = {**row, "reason": reason[:180]}
        result.append(row)
        used.add(lead_id)
    for row in rows:
        if str(row["lead_id"]) not in used:
            result.append(row)
    return result


async def rerank_with_ai(rows: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], str]:
    """Ask Tikun AI to order the gathered leads from their notes and call history."""
    from app.core.config import settings

    if not settings.ai_assistant_enabled or not settings.openai_api_key:
        return rows, "rules"
    candidates = [row for row in rows if row.get("priority_band") != BAND_DNC][:40]
    if len(candidates) < 2:
        return rows, "rules"
    briefs = [
        {
            "lead_id": str(row["lead_id"]),
            "name": row.get("customer_name"),
            "note": (row.get("note_preview") or "")[:240],
            "last_outcome": row.get("last_outcome"),
            "chips": row.get("chips") or [],
            "attempts_today": row.get("attempts_today") or 0,
            "rules_hint": row.get("reason"),
        }
        for row in candidates
    ]
    try:
        from app.services.ai_assistant_service import AiAssistantService

        client = AiAssistantService._client()
        completion = await client.chat.completions.create(
            model=settings.bdc_attention_model,
            temperature=0.2,
            response_format={"type": "json_object"},
            timeout=20,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You order a BDC agent's next phone calls. "
                        "Use only the note, last outcome, chips, and rules hint. "
                        "Call back, waiting, hot, coming in, a missed call, or an overdue follow-up "
                        "comes before a cold fresh lead. "
                        "A lead just tried with no answer stays lower unless the note says to call back now. "
                        "Do not invent facts. Each reason is one short sentence from the note or the hint. "
                        'Return JSON {"order":[{"lead_id":"...","reason":"..."}]} and include every lead_id once.'
                    ),
                },
                {"role": "user", "content": json.dumps({"leads": briefs})},
            ],
        )
        payload = json.loads(completion.choices[0].message.content or "{}")
        order = payload.get("order") if isinstance(payload, dict) else None
        if not isinstance(order, list) or not order:
            return rows, "rules"
        return apply_ai_order(rows, order), "ai"
    except Exception:
        logger.exception("AI call-next rank failed")
        return rows, "rules"


async def build_work_queue(
    db: AsyncSession,
    user,
    dealership_id: Optional[UUID],
    tz_name: Optional[str],
) -> WorkQueueResult:
    now = utc_now()
    today_start, today_end = day_bounds(now, tz_name)
    soon_end = now + timedelta(hours=2)
    accessible = await get_accessible_dealership_ids(db, user)
    base = _base_clauses(user.id, accessible, dealership_id)

    appt_ids = await _lead_ids(
        db,
        select(Appointment.lead_id, Appointment.scheduled_at)
        .join(Lead, Lead.id == Appointment.lead_id)
        .where(
            *base,
            Appointment.lead_id.isnot(None),
            Appointment.scheduled_at >= now - timedelta(minutes=15),
            Appointment.scheduled_at < today_end,
            Appointment.status.in_([AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED]),
        )
        .order_by(Appointment.scheduled_at.asc()),
        BUCKET_LIMIT,
    )
    follow_ids = await _lead_ids(
        db,
        select(FollowUp.lead_id, FollowUp.scheduled_at)
        .join(Lead, Lead.id == FollowUp.lead_id)
        .where(
            *base,
            FollowUp.status == FollowUpStatus.PENDING,
            FollowUp.scheduled_at < today_end,
        )
        .order_by(FollowUp.scheduled_at.asc()),
        BUCKET_LIMIT,
    )
    missed_ids = await _lead_ids(
        db,
        select(CallLog.lead_id, CallLog.started_at)
        .join(Lead, Lead.id == CallLog.lead_id)
        .where(
            *base,
            CallLog.direction == CallDirection.INBOUND,
            CallLog.started_at >= now - timedelta(days=MISSED_LOOKBACK_DAYS),
            or_(
                CallLog.outcome.in_(["missed", "voicemail"]),
                CallLog.status.in_(
                    [CallStatus.NO_ANSWER, CallStatus.BUSY, CallStatus.FAILED, CallStatus.CANCELED]
                ),
            ),
        )
        .order_by(CallLog.started_at.desc()),
        BUCKET_LIMIT,
    )
    inquiry_ids = await _lead_ids(
        db,
        select(Lead.id, Lead.last_inbound_at)
        .where(
            *base,
            Lead.last_inbound_at.isnot(None),
            or_(
                Lead.last_contacted_at.is_(None),
                Lead.last_contacted_at < Lead.last_inbound_at,
            ),
        )
        .order_by(Lead.last_inbound_at.desc()),
        BUCKET_LIMIT,
    )
    fresh_ids = await _lead_ids(
        db,
        select(Lead.id, Lead.created_at)
        .where(
            *base,
            Lead.first_contacted_at.is_(None),
            Lead.last_contacted_at.is_(None),
        )
        .order_by(Lead.created_at.desc()),
        BUCKET_LIMIT,
    )
    retry_ids = await _lead_ids(
        db,
        select(Lead.id, Lead.last_contacted_at)
        .where(
            *base,
            Lead.last_contacted_at.isnot(None),
            Lead.last_contacted_at <= now - timedelta(hours=2),
            Lead.last_contacted_at >= now - timedelta(days=MISSED_LOOKBACK_DAYS),
        )
        .order_by(Lead.last_contacted_at.asc()),
        BUCKET_LIMIT,
    )
    book_ids = await _lead_ids(
        db,
        select(Lead.id, Lead.last_activity_at)
        .where(*base, Lead.bdc_assigned_to_id == user.id)
        .order_by(Lead.last_activity_at.asc().nullsfirst()),
        BUCKET_LIMIT,
    )

    lead_ids: List[UUID] = []
    seen = set()
    for bucket in (appt_ids, missed_ids, inquiry_ids, follow_ids, fresh_ids, retry_ids, book_ids):
        for lead_id in bucket:
            if lead_id not in seen:
                seen.add(lead_id)
                lead_ids.append(lead_id)
    if not lead_ids:
        return WorkQueueResult(items=[])

    leads = (
        await db.execute(
            select(Lead)
            .where(Lead.id.in_(lead_ids))
            .options(selectinload(Lead.customer), selectinload(Lead.partner_store))
        )
    ).scalars().all()
    signals = await _signals_for(db, leads, now, today_start, today_end, soon_end)

    ranked: List[Dict[str, Any]] = []
    for lead in leads:
        scored = score_work_item(signals[lead.id], now)
        if scored is None:
            continue
        customer = lead.customer
        name = customer.full_name if customer else "Lead"
        store = lead.partner_store.name if lead.partner_store else None
        ranked.append(
            {
                "lead_id": lead.id,
                "customer_name": name,
                "phone": customer.phone if customer else None,
                "store_name": store,
                **scored,
            }
        )

    ranked.sort(key=lambda row: (-row["priority_score"], row["tie"]))
    top = ranked[:QUEUE_LIMIT]
    for index, row in enumerate(top, start=1):
        row["rank"] = index
        row.pop("tie", None)
    return WorkQueueResult(items=top, ranked_by="rules")


async def _signals_for(
    db: AsyncSession,
    leads: Sequence[Lead],
    now: datetime,
    today_start: datetime,
    today_end: datetime,
    soon_end: datetime,
) -> Dict[UUID, QueueSignals]:
    ids = [lead.id for lead in leads]
    by_id: Dict[UUID, QueueSignals] = {
        lead.id: QueueSignals(
            created_at=lead.created_at,
            first_contacted_at=lead.first_contacted_at,
            last_contacted_at=lead.last_contacted_at,
            last_activity_at=lead.last_activity_at,
            last_inbound_at=lead.last_inbound_at,
            summary_notes=lead.notes or "",
        )
        for lead in leads
    }

    note_rows = (
        await db.execute(
            select(Activity.lead_id, Activity.meta_data)
            .where(Activity.lead_id.in_(ids), Activity.type == ActivityType.NOTE_ADDED)
            .distinct(Activity.lead_id)
            .order_by(Activity.lead_id, desc(Activity.created_at))
        )
    ).all()
    for lead_id, meta in note_rows:
        if lead_id in by_id:
            by_id[lead_id].latest_note = _note_body(meta)

    follow_rows = (
        await db.execute(
            select(FollowUp.lead_id, FollowUp.scheduled_at).where(
                FollowUp.lead_id.in_(ids),
                FollowUp.status == FollowUpStatus.PENDING,
            )
        )
    ).all()
    for lead_id, scheduled_at in follow_rows:
        signals = by_id.get(lead_id)
        if signals is None or scheduled_at is None:
            continue
        when = _utc(scheduled_at)
        if when < now:
            if signals.overdue_at is None or when < _utc(signals.overdue_at):
                signals.overdue_at = when
        elif when < today_end:
            if signals.due_today_at is None or when < _utc(signals.due_today_at):
                signals.due_today_at = when
        else:
            signals.has_future_follow_up = True

    appt_rows = (
        await db.execute(
            select(Appointment.lead_id, Appointment.scheduled_at, Appointment.status)
            .where(
                Appointment.lead_id.in_(ids),
                Appointment.scheduled_at >= now - timedelta(minutes=15),
                Appointment.status.in_([AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED]),
            )
            .order_by(Appointment.scheduled_at.asc())
        )
    ).all()
    seen_appt = set()
    soon_start = now - timedelta(minutes=15)
    for lead_id, scheduled_at, status in appt_rows:
        if lead_id in seen_appt or lead_id not in by_id or scheduled_at is None:
            continue
        seen_appt.add(lead_id)
        signals = by_id[lead_id]
        when = _utc(scheduled_at)
        status_val = _enum_val(status)
        signals.has_upcoming_appointment = when >= now - timedelta(minutes=15)
        if soon_start <= when <= soon_end:
            signals.appointment_soon_at = when
            signals.appointment_soon_confirmed = status_val == AppointmentStatus.CONFIRMED.value
        elif when < today_end and status_val == AppointmentStatus.SCHEDULED.value:
            signals.appointment_today_at = when

    outbound_rows = (
        await db.execute(
            select(CallLog.lead_id, CallLog.started_at, CallLog.outcome, CallLog.status)
            .where(CallLog.lead_id.in_(ids), CallLog.direction == CallDirection.OUTBOUND)
            .distinct(CallLog.lead_id)
            .order_by(CallLog.lead_id, desc(CallLog.started_at))
        )
    ).all()
    inbound_rows = (
        await db.execute(
            select(CallLog.lead_id, CallLog.started_at, CallLog.outcome, CallLog.status)
            .where(CallLog.lead_id.in_(ids), CallLog.direction == CallDirection.INBOUND)
            .distinct(CallLog.lead_id)
            .order_by(CallLog.lead_id, desc(CallLog.started_at))
        )
    ).all()
    activity_rows = (
        await db.execute(
            select(Activity.lead_id, Activity.created_at, Activity.meta_data)
            .where(Activity.lead_id.in_(ids), Activity.type == ActivityType.CALL_LOGGED)
            .distinct(Activity.lead_id)
            .order_by(Activity.lead_id, desc(Activity.created_at))
        )
    ).all()

    outbound: Dict[UUID, tuple] = {}
    for lead_id, started_at, outcome, status in outbound_rows:
        outbound[lead_id] = (_utc(started_at), _enum_val(outcome), _enum_val(status), "call")
    inbound: Dict[UUID, tuple] = {}
    for lead_id, started_at, outcome, status in inbound_rows:
        inbound[lead_id] = (_utc(started_at), _enum_val(outcome), _enum_val(status))
    for lead_id, created_at, meta in activity_rows:
        meta = meta or {}
        direction = str(meta.get("direction") or "outbound").lower()
        outcome = _enum_val(meta.get("outcome"))
        status = _enum_val(meta.get("status"))
        at = _utc(created_at)
        if direction == "inbound":
            current = inbound.get(lead_id)
            if current is None or (at and (current[0] is None or at > current[0])):
                inbound[lead_id] = (at, outcome, status)
        else:
            current = outbound.get(lead_id)
            if current is None or (at and (current[0] is None or at > current[0])):
                outbound[lead_id] = (at, outcome, status, "activity")

    attempt_rows = (
        await db.execute(
            select(Activity.lead_id, func.count())
            .where(
                Activity.lead_id.in_(ids),
                Activity.type == ActivityType.CALL_LOGGED,
                Activity.created_at >= today_start,
            )
            .group_by(Activity.lead_id)
        )
    ).all()
    attempts = {lead_id: int(count or 0) for lead_id, count in attempt_rows}
    missing_attempts = [lead_id for lead_id in ids if attempts.get(lead_id, 0) == 0]
    if missing_attempts:
        call_counts = (
            await db.execute(
                select(CallLog.lead_id, func.count())
                .where(
                    CallLog.lead_id.in_(missing_attempts),
                    CallLog.direction == CallDirection.OUTBOUND,
                    CallLog.started_at >= today_start,
                )
                .group_by(CallLog.lead_id)
            )
        ).all()
        for lead_id, count in call_counts:
            attempts[lead_id] = int(count or 0)

    for lead_id, signals in by_id.items():
        signals.attempts_today = attempts.get(lead_id, 0)
        out = outbound.get(lead_id)
        inc = inbound.get(lead_id)
        if out and out[0] is not None:
            at, outcome, status, _source = out
            if _is_unsuccessful(outcome, status):
                signals.last_unsuccessful_at = at
            signals.last_outcome = _outcome_label(outcome, status)
        if inc and inc[0] is not None and _is_missed_inbound(inc[1], inc[2]):
            out_at = out[0] if out else None
            if out_at is None or inc[0] > out_at:
                signals.unanswered_inbound_at = inc[0]
                if signals.last_outcome is None:
                    signals.last_outcome = _outcome_label(inc[1], inc[2])

    return by_id


async def apply_disposition(
    db: AsyncSession,
    user,
    lead_id: UUID,
    outcome_key: str,
    tz_name: Optional[str],
) -> None:
    spec = DISPOSITIONS.get(outcome_key)
    if spec is None:
        raise WorkQueueError(400, "Unknown outcome")

    lead = await db.get(Lead, lead_id)
    if lead is None:
        raise WorkQueueError(404, "Lead not found")
    if not lead.is_active or lead.outcome in {"converted", "lost"}:
        raise WorkQueueError(400, "This lead is closed")
    if lead.bdc_assigned_to_id not in (None, user.id):
        raise WorkQueueError(403, "This lead is assigned to another BDC agent")

    from app.core.access_scope import user_can_access_lead

    if not await user_can_access_lead(db, user, lead.dealership_id, lead.assigned_to):
        raise WorkQueueError(403, "Not authorized to update this lead")

    from app.api.v1.endpoints.leads import auto_assign_on_first_activity

    now = utc_now()
    await auto_assign_on_first_activity(db, lead, user, "call", None)

    lead.last_contacted_at = now
    lead.last_activity_at = now
    if not lead.first_contacted_at:
        lead.first_contacted_at = now

    performer = f"{user.first_name} {user.last_name}".strip()
    await ActivityService.log_activity(
        db,
        activity_type=ActivityType.CALL_LOGGED,
        description=f"Call logged by {performer}: {spec['outcome']}",
        user_id=user.id,
        lead_id=lead.id,
        dealership_id=lead.dealership_id,
        meta_data={
            "outcome": spec["outcome"],
            "notes": spec["note"],
            "performer_name": performer,
            "source": "bdc_work_queue",
        },
    )

    if spec["write_note"]:
        await ActivityService.log_activity(
            db,
            activity_type=ActivityType.NOTE_ADDED,
            description=f"Note added by {performer}",
            user_id=user.id,
            lead_id=lead.id,
            dealership_id=lead.dealership_id,
            meta_data={
                "content": spec["note"],
                "performer_name": performer,
                "source": "bdc_work_queue",
            },
        )

    _, today_end = day_bounds(now, tz_name)
    pending = (
        await db.execute(
            select(FollowUp).where(
                FollowUp.lead_id == lead.id,
                FollowUp.status == FollowUpStatus.PENDING,
                FollowUp.scheduled_at < today_end,
            )
        )
    ).scalars().all()
    for follow_up in pending:
        follow_up.status = FollowUpStatus.COMPLETED
        follow_up.completed_at = now
        follow_up.completion_notes = spec["note"]
        await ActivityService.log_activity(
            db,
            activity_type=ActivityType.FOLLOW_UP_COMPLETED,
            description=f"Follow-up completed: {spec['note']}",
            user_id=user.id,
            lead_id=lead.id,
            dealership_id=lead.dealership_id,
            meta_data={"source": "bdc_work_queue", "notes": spec["note"]},
        )

    if spec["follow_up"]:
        scheduled_at = next_touch_at(now, tz_name, spec["follow_up"])
        follow_up = FollowUp(
            lead_id=lead.id,
            assigned_to=user.id,
            scheduled_at=scheduled_at,
            notes=spec["note"],
            status=FollowUpStatus.PENDING,
        )
        db.add(follow_up)
        await db.flush()
        await ActivityService.log_activity(
            db,
            activity_type=ActivityType.FOLLOW_UP_SCHEDULED,
            description=f"Follow-up scheduled for {scheduled_at.strftime('%Y-%m-%d %H:%M')}",
            user_id=user.id,
            lead_id=lead.id,
            dealership_id=lead.dealership_id,
            meta_data={
                "scheduled_at": scheduled_at.isoformat(),
                "source": "bdc_work_queue",
            },
        )

    await db.flush()
