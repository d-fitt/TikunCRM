"""
Morning attention pass for a BDC agent.

gpt-4o-mini reads every eligible lead once: notes, follow-ups, appointments,
and calls. The saved list is what the Call next tab shows. A manual recheck
runs the same pass.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from uuid import UUID

from sqlalchemy import desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.timezone import utc_now
from app.models.activity import Activity, ActivityType
from app.models.bdc_attention import SHARED_ATTENTION_ID, BdcAttentionSnapshot
from app.models.call_log import CallLog
from app.models.lead import Lead
from app.models.user import User
from app.services.bdc_work_queue_service import (
    BAND_DNC,
    _note_bits,
    _signals_for,
    day_bounds,
    score_work_item,
)

logger = logging.getLogger(__name__)

BATCH_SIZE = 15
LEAD_CHUNK = 80
ATTENTION_LIMIT = 150
RUNNING_STALE_SECONDS = 20 * 60

_PROMPT = (
    "You are reviewing a BDC agent's book before the morning shift in America/New_York. "
    "Read every lead in this batch. Use the notes in order, newest first, and the past calls "
    "(direction, outcome, length, and the note written on that call). "
    "Also use the follow-up, the appointment, and the rules hint. Decide who needs a call or a confirmation today. "
    "Call back, waiting, hot, ready, coming in, a missed call, an overdue or due follow-up, "
    "an unconfirmed appointment, a fresh lead, and someone gone quiet all need attention. "
    "Skip do-not-call, wrong number, and not interested. "
    "Skip a lead called in the last two hours unless the note says to call back now "
    "or they have an appointment soon. "
    "Do not invent facts. Only use what is in the notes, past calls, follow-up, or appointment. "
    "why is two short sentences: why call this person now. "
    "ask is the exact question she should ask, based on those notes and calls. "
    "If they are coming in, ask her to confirm the time. If they asked for a callback, tell her to call back about that. "
    "If there is no specific question in the notes, ask whether they are still looking and ready to set a time to come in. "
    "priority is 1 to 100, higher means call sooner. action is call, confirm, or book. "
    'Return JSON {"attention":[{"lead_id","priority","why","ask","action"}]} '
    "with only the leads who need attention. Omit the rest."
)


def merge_attention(found: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keep the higher priority when the same lead appears twice, then number the list."""
    by_id: Dict[str, Dict[str, Any]] = {}
    for row in found:
        lead_id = str(row.get("lead_id") or "")
        if not lead_id:
            continue
        previous = by_id.get(lead_id)
        if previous is None or int(row.get("priority") or 0) > int(previous.get("priority") or 0):
            by_id[lead_id] = row
    ordered = sorted(by_id.values(), key=lambda row: -int(row.get("priority") or 0))
    ordered = ordered[:ATTENTION_LIMIT]
    for index, row in enumerate(ordered, start=1):
        row["rank"] = index
    return ordered


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    return value.isoformat()


def _follow_label(signals) -> str:
    if signals.overdue_at is not None:
        return f"overdue follow-up since {_iso(signals.overdue_at)}"
    if signals.due_today_at is not None:
        return f"follow-up due today at {_iso(signals.due_today_at)}"
    if signals.has_future_follow_up:
        return "a later follow-up is already set"
    return "no follow-up"


def _appointment_label(signals) -> str:
    if signals.appointment_soon_at is not None:
        state = "confirmed" if signals.appointment_soon_confirmed else "not confirmed"
        return f"appointment within 2 hours at {_iso(signals.appointment_soon_at)} ({state})"
    if signals.appointment_today_at is not None:
        return f"appointment later today at {_iso(signals.appointment_today_at)}, not confirmed"
    if signals.has_upcoming_appointment:
        return "an appointment is already booked after today"
    return "no appointment"


async def _recent_notes(db: AsyncSession, lead_ids: List[UUID]) -> Dict[UUID, List[str]]:
    if not lead_ids:
        return {}
    rows = (
        await db.execute(
            select(Activity.lead_id, Activity.meta_data, Activity.created_at)
            .where(Activity.lead_id.in_(lead_ids), Activity.type == ActivityType.NOTE_ADDED)
            .order_by(Activity.lead_id, desc(Activity.created_at))
        )
    ).all()
    grouped: Dict[UUID, List[str]] = {}
    for lead_id, meta, _created in rows:
        bucket = grouped.setdefault(lead_id, [])
        if len(bucket) >= 8:
            continue
        if isinstance(meta, dict):
            text = str(meta.get("content") or meta.get("notes") or "").strip()
        else:
            text = ""
        if text:
            bucket.append(text[:800])
    return grouped


def _enum_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value.value if hasattr(value, "value") else value)


async def _recent_calls(db: AsyncSession, lead_ids: List[UUID]) -> Dict[UUID, List[str]]:
    """Newest calls first: outcome, length, and the note saved on the call."""
    if not lead_ids:
        return {}
    rows = (
        await db.execute(
            select(CallLog)
            .where(CallLog.lead_id.in_(lead_ids))
            .order_by(CallLog.lead_id, desc(CallLog.started_at))
        )
    ).scalars().all()
    grouped: Dict[UUID, List[str]] = {}
    for call in rows:
        bucket = grouped.setdefault(call.lead_id, [])
        if len(bucket) >= 6:
            continue
        pieces = [
            _enum_text(call.direction),
            _enum_text(call.status),
        ]
        if call.outcome:
            pieces.append(f"outcome {call.outcome}")
        if call.duration_seconds:
            pieces.append(f"{call.duration_seconds}s")
        if call.started_at:
            pieces.append(_iso(call.started_at) or "")
        if call.notes:
            pieces.append(f"note: {call.notes.strip()[:500]}")
        grouped[call.lead_id].append(" · ".join(piece for piece in pieces if piece))
    return grouped


def _brief(lead: Lead, signals, scored: Optional[Dict[str, Any]], notes: List[str], calls: List[str]) -> Dict[str, Any]:
    customer = lead.customer
    name = customer.full_name if customer and customer.full_name else "Lead"
    return {
        "lead_id": str(lead.id),
        "name": name,
        "store": lead.partner_store.name if lead.partner_store else None,
        "created_at": _iso(lead.created_at),
        "last_contacted_at": _iso(signals.last_contacted_at),
        "last_outcome": signals.last_outcome,
        "attempts_today": signals.attempts_today,
        "missed_inbound": signals.unanswered_inbound_at is not None,
        "new_inquiry_at": _iso(signals.last_inbound_at),
        "follow_up": _follow_label(signals),
        "appointment": _appointment_label(signals),
        "notes": notes[:8],
        "past_calls": calls[:6],
        "summary": (signals.summary_notes or "")[:300],
        "rules_hint": (scored or {}).get("reason") or "No rules flag",
        "chips": (scored or {}).get("chips") or [],
    }


def _item_from_model(lead: Lead, signals, scored: Optional[Dict[str, Any]], choice: Dict[str, Any]) -> Dict[str, Any]:
    customer = lead.customer
    name = customer.full_name if customer and customer.full_name else "Lead"
    action = str(choice.get("action") or (scored or {}).get("action") or "call").lower()
    if action not in {"call", "confirm", "book"}:
        action = (scored or {}).get("action") or "call"
    reason = str(choice.get("why") or choice.get("reason") or (scored or {}).get("reason") or "Needs a call").strip()[:400]
    ask = str(choice.get("ask") or "").strip()[:300]
    preview = (signals.latest_note or (scored or {}).get("note_preview") or "").strip()
    preview = preview[:500] or None
    return {
        "lead_id": str(lead.id),
        "dealership_id": str(lead.dealership_id) if lead.dealership_id else None,
        "customer_name": name,
        "phone": customer.phone if customer else None,
        "store_name": lead.partner_store.name if lead.partner_store else None,
        "priority_band": (scored or {}).get("priority_band") or "ai_attention",
        "priority_score": int(choice.get("priority") or 0),
        "priority": int(choice.get("priority") or 0),
        "reason": reason,
        "why": reason,
        "ask": ask or None,
        "action": action,
        "note_preview": preview,
        "chips": (scored or {}).get("chips") or [],
        "last_outcome": signals.last_outcome,
        "attempts_today": signals.attempts_today,
    }


async def _load_snapshot(db: AsyncSession) -> BdcAttentionSnapshot:
    snap = await db.get(BdcAttentionSnapshot, SHARED_ATTENTION_ID)
    if snap is None:
        snap = BdcAttentionSnapshot(id=SHARED_ATTENTION_ID, status="empty", items=[], claimed={})
        db.add(snap)
        await db.flush()
    return snap


def _active_claims(claimed: Optional[dict], today_start: datetime) -> Dict[str, Any]:
    """Claims from today stay off the list. Yesterday's claims can come back tomorrow."""
    kept: Dict[str, Any] = {}
    for lead_id, info in (claimed or {}).items():
        if not isinstance(info, dict):
            continue
        raw = info.get("at")
        if not raw:
            continue
        try:
            when = datetime.fromisoformat(str(raw))
        except ValueError:
            continue
        if when.tzinfo is None:
            from datetime import timezone
            when = when.replace(tzinfo=timezone.utc)
        if when >= today_start:
            kept[str(lead_id)] = info
    return kept


def _without_claimed(items: List[Dict[str, Any]], claimed: Dict[str, Any]) -> List[Dict[str, Any]]:
    hidden = set(claimed)
    visible = [dict(row) for row in items if str(row.get("lead_id")) not in hidden]
    for index, row in enumerate(visible, start=1):
        row["rank"] = index
    return visible


def _percent(done: int, total: int, start: int, span: int) -> int:
    if total <= 0:
        return start + span
    return start + int(span * min(done, total) / total)


async def _write_progress(db: AsyncSession, done: int, label: str) -> None:
    row = await db.get(BdcAttentionSnapshot, SHARED_ATTENTION_ID)
    if row is None:
        return
    row.progress_done = max(0, min(done, 100))
    row.progress_total = 100
    row.progress_label = label[:160]
    await db.commit()


def _running_fresh(snap: BdcAttentionSnapshot, now: datetime) -> bool:
    if snap.status != "running" or snap.started_at is None:
        return False
    started = snap.started_at
    if started.tzinfo is None:
        from datetime import timezone
        started = started.replace(tzinfo=timezone.utc)
    return (now - started).total_seconds() < RUNNING_STALE_SECONDS


async def snapshot_view(
    db: AsyncSession,
    user: User,
    dealership_id: Optional[UUID],
) -> Dict[str, Any]:
    snap = await db.get(BdcAttentionSnapshot, SHARED_ATTENTION_ID)
    if snap is None:
        return {
            "items": [],
            "ranked_by": "ai",
            "status": "empty",
            "generated_at": None,
            "scanned_count": 0,
            "attention_count": 0,
            "progress_done": 0,
            "progress_total": 0,
            "progress_label": None,
            "error": None,
            "model": settings.bdc_attention_model,
        }
    today_start, _today_end = day_bounds(utc_now(), "America/New_York")
    claimed = _active_claims(snap.claimed, today_start)
    items = _without_claimed(list(snap.items or []), claimed)
    return {
        "items": items,
        "ranked_by": "ai",
        "status": snap.status,
        "generated_at": snap.generated_at,
        "scanned_count": snap.scanned_count,
        "attention_count": snap.attention_count,
        "progress_done": snap.progress_done or 0,
        "progress_total": snap.progress_total or 0,
        "progress_label": snap.progress_label,
        "error": snap.error,
        "model": snap.model or settings.bdc_attention_model,
    }


async def drop_lead_from_snapshot(db: AsyncSession, lead_id: UUID) -> None:
    snap = await db.get(BdcAttentionSnapshot, SHARED_ATTENTION_ID)
    if snap is None or not snap.items:
        return
    target = str(lead_id)
    kept = [row for row in snap.items if str(row.get("lead_id")) != target]
    for index, row in enumerate(kept, start=1):
        row["rank"] = index
    snap.items = kept
    snap.attention_count = len(kept)
    await db.flush()


async def claim_lead_for_call(db: AsyncSession, user: User, lead_id: UUID) -> bool:
    """
    Take this lead off the shared Call next list when a call starts.
    Another person can still dial the same customer.
    """
    snap = (
        await db.execute(
            select(BdcAttentionSnapshot)
            .where(BdcAttentionSnapshot.id == SHARED_ATTENTION_ID)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if snap is None:
        snap = BdcAttentionSnapshot(id=SHARED_ATTENTION_ID, status="empty", items=[], claimed={})
        db.add(snap)
        await db.flush()
    today_start, _today_end = day_bounds(utc_now(), "America/New_York")
    claimed = _active_claims(snap.claimed, today_start)
    key = str(lead_id)
    existing = claimed.get(key)
    if existing and existing.get("user_id") != str(user.id):
        return True
    name = f"{user.first_name or ''} {user.last_name or ''}".strip() or user.email
    claimed[key] = {"user_id": str(user.id), "name": name, "at": utc_now().isoformat()}
    snap.claimed = claimed
    kept = [row for row in (snap.items or []) if str(row.get("lead_id")) != key]
    for index, row in enumerate(kept, start=1):
        row["rank"] = index
    snap.items = kept
    snap.attention_count = len(kept)
    await db.commit()
    try:
        from app.services.notification_service import emit_stats_refresh
        await emit_stats_refresh(None, db=db)
    except Exception:
        logger.exception("Could not refresh BDC lists after a call started")
    return True


async def _rank_batch(client, briefs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    completion = await client.chat.completions.create(
        model=settings.bdc_attention_model,
        temperature=0.2,
        response_format={"type": "json_object"},
        timeout=45,
        messages=[
            {"role": "system", "content": _PROMPT},
            {"role": "user", "content": json.dumps({"leads": briefs})},
        ],
    )
    payload = json.loads(completion.choices[0].message.content or "{}")
    attention = payload.get("attention") if isinstance(payload, dict) else None
    if not isinstance(attention, list):
        return []
    return [row for row in attention if isinstance(row, dict)]


async def run_attention_for_user(
    db: AsyncSession,
    user: User,
    tz_name: str = "America/New_York",
) -> BdcAttentionSnapshot:
    """Scan every active lead once and replace the shared list."""
    now = utc_now()
    snap = await _load_snapshot(db)
    if _running_fresh(snap, now):
        return snap

    snap.status = "running"
    snap.started_at = now
    snap.error = None
    snap.progress_done = 0
    snap.progress_total = 100
    snap.progress_label = "Counting leads"
    snap.model = settings.bdc_attention_model
    await db.commit()
    snap = await _load_snapshot(db)

    if not settings.ai_assistant_enabled or not settings.openai_api_key:
        snap.status = "failed"
        snap.error = "Tikun AI is not configured."
        await db.commit()
        return snap

    try:
        from app.services.ai_assistant_service import AiAssistantService

        today_start, today_end = day_bounds(now, tz_name)
        soon_end = now + timedelta(hours=2)
        claimed = _active_claims(snap.claimed, today_start)
        lead_ids = list(
            (
                await db.execute(
                    select(Lead.id).where(
                        Lead.is_active.is_(True),
                        or_(Lead.outcome.is_(None), Lead.outcome.notin_(("converted", "lost"))),
                    )
                )
            ).scalars().all()
        )

        catalog: Dict[str, Dict[str, Any]] = {}
        briefs: List[Dict[str, Any]] = []
        for offset in range(0, len(lead_ids), LEAD_CHUNK):
            chunk = lead_ids[offset:offset + LEAD_CHUNK]
            leads = (
                await db.execute(
                    select(Lead)
                    .where(Lead.id.in_(chunk))
                    .options(selectinload(Lead.customer), selectinload(Lead.partner_store))
                )
            ).scalars().all()
            signals_by_id = await _signals_for(db, leads, now, today_start, today_end, soon_end)
            notes_by_id = await _recent_notes(db, [lead.id for lead in leads])
            calls_by_id = await _recent_calls(db, [lead.id for lead in leads])
            for lead in leads:
                signals = signals_by_id[lead.id]
                _primary, _chips, sink, _boost = _note_bits(signals)
                scored = score_work_item(signals, now)
                if sink or (scored and scored.get("priority_band") == BAND_DNC):
                    continue
                if str(lead.id) in claimed:
                    continue
                notes = notes_by_id.get(lead.id) or []
                if signals.latest_note and signals.latest_note not in notes:
                    notes = [signals.latest_note, *notes][:8]
                calls = calls_by_id.get(lead.id) or []
                brief = _brief(lead, signals, scored, notes, calls)
                briefs.append(brief)
                catalog[str(lead.id)] = _item_from_model(lead, signals, scored, {"priority": 0, "reason": brief["rules_hint"], "action": (scored or {}).get("action")})
            reviewed = min(offset + len(chunk), len(lead_ids))
            await _write_progress(
                db,
                _percent(reviewed, len(lead_ids), 0, 35),
                f"Reading notes and calls · {reviewed:,} of {len(lead_ids):,}",
            )

        client = AiAssistantService._client()
        found: List[Dict[str, Any]] = []
        failures = 0
        batches = 0
        pending = [briefs[offset:offset + BATCH_SIZE] for offset in range(0, len(briefs), BATCH_SIZE)]

        async def _rank_one(batch: List[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], bool]:
            try:
                return await _rank_batch(client, batch), False
            except Exception:
                logger.exception("Mini attention batch failed")
                return [], True

        ranked = 0
        for group_at in range(0, len(pending), 4):
            group = pending[group_at:group_at + 4]
            results = await asyncio.gather(*[_rank_one(batch) for batch in group])
            for rows, failed in results:
                batches += 1
                ranked += BATCH_SIZE
                if failed:
                    failures += 1
                else:
                    found.extend(rows)
            await _write_progress(
                db,
                _percent(min(ranked, len(briefs)), len(briefs), 35, 65),
                f"Choosing who to call · {min(ranked, len(briefs)):,} of {len(briefs):,}",
            )

        if batches and failures == batches:
            raise RuntimeError("Every attention batch failed.")

        chosen = merge_attention(found)
        items: List[Dict[str, Any]] = []
        for row in chosen:
            base_item = catalog.get(str(row.get("lead_id")))
            if base_item is None:
                continue
            item = dict(base_item)
            item["priority"] = int(row.get("priority") or 0)
            item["priority_score"] = item["priority"]
            why = str(row.get("why") or row.get("reason") or "").strip()
            ask = str(row.get("ask") or "").strip()
            if why:
                item["why"] = why[:400]
                item["reason"] = why[:400]
            if ask:
                item["ask"] = ask[:300]
            action = str(row.get("action") or "").lower()
            if action in {"call", "confirm", "book"}:
                item["action"] = action
            item["rank"] = row["rank"]
            if str(item["lead_id"]) in claimed:
                continue
            items.append(item)

        for index, row in enumerate(items, start=1):
            row["rank"] = index

        db.expire(snap)
        snap = (
            await db.execute(
                select(BdcAttentionSnapshot)
                .where(BdcAttentionSnapshot.id == SHARED_ATTENTION_ID)
                .with_for_update()
            )
        ).scalar_one()
        latest = _active_claims(snap.claimed, today_start)
        hidden = set(claimed) | set(latest)
        items = [row for row in items if str(row.get("lead_id")) not in hidden]
        for index, row in enumerate(items, start=1):
            row["rank"] = index
        merged = dict(claimed)
        merged.update(latest)
        snap.items = items
        snap.claimed = merged
        snap.scanned_count = len(lead_ids)
        snap.attention_count = len(items)
        snap.progress_done = 100
        snap.progress_total = 100
        snap.progress_label = None
        snap.generated_at = utc_now()
        snap.status = "ready"
        snap.error = None
        snap.model = settings.bdc_attention_model
        await db.commit()
        try:
            from app.services.notification_service import emit_stats_refresh
            await emit_stats_refresh(None, db=db)
        except Exception:
            logger.exception("Could not emit stats refresh after attention pass")
        return snap
    except Exception as exc:
        logger.exception("BDC attention pass failed for %s", user.id)
        snap = await _load_snapshot(db)
        snap.status = "failed"
        snap.error = str(exc)[:500]
        await db.commit()
        return snap
