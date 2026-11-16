"""
Call Reviews API — AI call feedback and the manager-editable scoring rubric.

Access:
  Managers (super admin, dealership admin/owner) see every review and manage the rubric.
  Everyone else (salesperson, BDC) sees only reviews of their own calls.
"""
import asyncio
import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import deps
from app.core.config import settings
from app.core.permissions import UserRole
from app.core.timezone import utc_now
from app.db.database import get_db
from app.models.call_log import CallLog, CallStatus
from app.models.call_review import (
    CallEvaluation,
    CallReview,
    CallReviewStatus,
    CallRubric,
    RubricStatus,
)
from app.models.customer import Customer
from app.models.dealership import Dealership
from app.models.lead import Lead
from app.models.user import User
from app.services import call_evaluation_service as evaluation
from app.services import call_review_service as reviews

logger = logging.getLogger(__name__)

router = APIRouter()

MANAGER_ROLES = (UserRole.SUPER_ADMIN, UserRole.DEALERSHIP_ADMIN, UserRole.DEALERSHIP_OWNER)
MAX_TEST_CALLS = 5
_IN_FLIGHT = (CallReviewStatus.TRANSCRIBING.value, CallReviewStatus.EVALUATING.value)


def _is_manager(user: User) -> bool:
    return user.role in MANAGER_ROLES


def _mark_queued(review: CallReview) -> None:
    """
    Show the review as queued straight away, so the page reports progress from the
    moment the manager clicks (and the retry sweep can pick it up if the server
    restarts before the background task runs). A review already being processed is left alone.
    """
    if review.status not in _IN_FLIGHT:
        review.status = CallReviewStatus.PENDING.value
        review.error = None
        review.skip_reason = None
    # A manual run gets a fresh set of automatic retries
    review.attempts = 0


# ------------------------------------------------------------------ schemas --

class RubricCriterion(BaseModel):
    key: Optional[str] = None
    name: str
    weight: float
    what_good_looks_like: str = ""
    what_bad_looks_like: str = ""


class RubricDraftRequest(BaseModel):
    name: str = Field(default="Call scoring rubric", max_length=200)
    criteria: List[RubricCriterion]
    guidance: Optional[str] = None
    change_note: Optional[str] = Field(default=None, max_length=500)


class RubricTestRequest(BaseModel):
    review_ids: List[UUID] = Field(min_length=1, max_length=MAX_TEST_CALLS)
    criteria: List[RubricCriterion]
    guidance: Optional[str] = None


def _rubric_dict(r: Optional[CallRubric]) -> Optional[Dict[str, Any]]:
    if r is None:
        return None
    return {
        "id": str(r.id),
        "version": r.version,
        "status": r.status,
        "name": r.name,
        "criteria": r.criteria,
        "guidance": r.guidance,
        "change_note": r.change_note,
        "published_at": r.published_at.isoformat() if r.published_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


def _validated(criteria: List[RubricCriterion], guidance: Optional[str]):
    try:
        return (
            evaluation.validate_rubric_criteria([c.model_dump() for c in criteria]),
            evaluation.validate_guidance(guidance),
        )
    except evaluation.RubricValidationError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)) from None


async def _get_draft(db: AsyncSession) -> Optional[CallRubric]:
    result = await db.execute(
        select(CallRubric)
        .where(CallRubric.status == RubricStatus.DRAFT.value)
        .order_by(CallRubric.updated_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


# ------------------------------------------------------------------- rubric --

@router.get("/rubric")
async def get_rubric(
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """The rubric calls are currently scored with, plus the unpublished draft (managers only)."""
    active = await reviews.get_active_rubric(db)
    draft = await _get_draft(db) if _is_manager(current_user) else None
    return {
        "active": _rubric_dict(active),
        "draft": _rubric_dict(draft),
        "can_edit": _is_manager(current_user),
        "ai_outcomes": list(evaluation.AI_CALL_OUTCOMES),
    }


@router.get("/rubric/versions")
async def list_rubric_versions(
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Every published version, newest first, with how many calls each one scored."""
    result = await db.execute(
        select(CallRubric).where(CallRubric.version.isnot(None)).order_by(CallRubric.version.desc())
    )
    rubrics = result.scalars().all()
    counts = dict(
        (
            await db.execute(
                select(CallEvaluation.rubric_version, func.count(CallEvaluation.id))
                .where(CallEvaluation.is_current.is_(True))
                .group_by(CallEvaluation.rubric_version)
            )
        ).all()
    )
    return [{**_rubric_dict(r), "calls_scored": counts.get(r.version, 0)} for r in rubrics]


@router.put("/rubric/draft")
async def save_rubric_draft(
    body: RubricDraftRequest,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Save changes as a draft. Nothing is scored with a draft until it is published."""
    criteria, guidance = _validated(body.criteria, body.guidance)
    draft = await _get_draft(db)
    if draft is None:
        draft = CallRubric(status=RubricStatus.DRAFT.value, created_by=current_user.id)
        db.add(draft)
    draft.name = body.name.strip() or "Call scoring rubric"
    draft.criteria = criteria
    draft.guidance = guidance
    draft.change_note = (body.change_note or "").strip() or None
    await db.commit()
    await db.refresh(draft)
    return _rubric_dict(draft)


@router.delete("/rubric/draft", status_code=status.HTTP_204_NO_CONTENT)
async def discard_rubric_draft(
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    draft = await _get_draft(db)
    if draft is not None:
        await db.delete(draft)
        await db.commit()


@router.post("/rubric/draft/publish")
async def publish_rubric_draft(
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    """
    Make the draft the active rubric as a new version. Applies to calls reviewed
    from now on; existing evaluations keep the version they were scored with.
    """
    draft = await _get_draft(db)
    if draft is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="There is no draft to publish")
    try:
        draft.criteria = evaluation.validate_rubric_criteria(draft.criteria)
    except evaluation.RubricValidationError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)) from None

    max_version = (await db.execute(select(func.max(CallRubric.version)))).scalar() or 0
    current = (
        await db.execute(select(CallRubric).where(CallRubric.status == RubricStatus.ACTIVE.value))
    ).scalars().all()
    for r in current:
        r.status = RubricStatus.ARCHIVED.value

    draft.version = max_version + 1
    draft.status = RubricStatus.ACTIVE.value
    draft.published_by = current_user.id
    draft.published_at = utc_now()
    await db.commit()
    await db.refresh(draft)
    logger.info("Call rubric v%s published by user %s", draft.version, current_user.id)
    return _rubric_dict(draft)


@router.post("/rubric/test")
async def test_rubric(
    body: RubricTestRequest,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    """
    Try unsaved criteria on a few already-transcribed calls and compare with their
    current scores. Nothing is stored.
    """
    criteria, guidance = _validated(body.criteria, body.guidance)

    result = await db.execute(select(CallReview).where(CallReview.id.in_(body.review_ids)))
    review_rows = [r for r in result.scalars().all() if r.transcript]
    if not review_rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="None of those calls has a transcript")

    current = await _current_evaluations(db, [r.id for r in review_rows])
    call_logs = await _by_id(db, CallLog, [r.call_log_id for r in review_rows])

    async def _run(review: CallReview) -> Dict[str, Any]:
        call = call_logs.get(review.call_log_id)
        cur = current.get(review.id)
        item: Dict[str, Any] = {
            "review_id": str(review.id),
            "call_started_at": review.call_started_at.isoformat() if review.call_started_at else None,
            "current": (
                {
                    "overall_score": cur.overall_score,
                    "rubric_version": cur.rubric_version,
                    "category_scores": cur.category_scores,
                }
                if cur
                else None
            ),
            "draft": None,
            "error": None,
        }
        try:
            evaluated = await evaluation.evaluate_transcript(
                review.transcript, criteria, guidance, call.direction.value if call and call.direction else None
            )
            item["draft"] = {
                "overall_score": evaluated["overall_score"],
                "category_scores": evaluated["category_scores"],
                "summary": evaluated["result"]["summary"],
            }
        except evaluation.EvaluationError as e:
            item["error"] = str(e)
        return item

    return {"results": await asyncio.gather(*[_run(r) for r in review_rows])}


# ------------------------------------------------------------- list helpers --

async def _by_id(db: AsyncSession, model, ids: List[Any]) -> Dict[Any, Any]:
    ids = [i for i in set(ids) if i is not None]
    if not ids:
        return {}
    result = await db.execute(select(model).where(model.id.in_(ids)))
    return {row.id: row for row in result.scalars().all()}


async def _current_evaluations(db: AsyncSession, review_ids: List[UUID]) -> Dict[UUID, CallEvaluation]:
    if not review_ids:
        return {}
    result = await db.execute(
        select(CallEvaluation)
        .where(CallEvaluation.review_id.in_(review_ids), CallEvaluation.is_current.is_(True))
        .order_by(CallEvaluation.created_at.asc())
    )
    return {e.review_id: e for e in result.scalars().all()}


async def _customer_names(db: AsyncSession, rows: List[Any]) -> Dict[Any, Optional[str]]:
    """
    Customer display name per row (anything with .id, .customer_id and .lead_id).
    Falls back to the lead's customer when the row has no customer of its own.
    """
    lead_ids = [r.lead_id for r in rows if r.customer_id is None and r.lead_id is not None]
    lead_customer: Dict[Any, Any] = {}
    if lead_ids:
        result = await db.execute(select(Lead.id, Lead.customer_id).where(Lead.id.in_(set(lead_ids))))
        lead_customer = {lead_id: customer_id for lead_id, customer_id in result.all()}
    resolved = {r.id: r.customer_id or lead_customer.get(r.lead_id) for r in rows}
    customers = await _by_id(db, Customer, list(resolved.values()))
    return {
        row_id: (customers[cid].full_name if cid in customers else None) for row_id, cid in resolved.items()
    }


def _call_dict(call: Optional[CallLog]) -> Optional[Dict[str, Any]]:
    if call is None:
        return None
    return {
        "id": str(call.id),
        "direction": call.direction.value if call.direction else None,
        "started_at": call.started_at.isoformat() if call.started_at else None,
        "duration_seconds": call.recording_duration_seconds or call.duration_seconds or 0,
        "has_recording": bool(call.recording_url),
    }


# -------------------------------------------------------------------- lists --

@router.get("")
async def list_call_reviews(
    review_status: Optional[str] = Query(None, alias="status"),
    rep_user_id: Optional[UUID] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """Reviewed calls, newest first."""
    conditions = []
    if not _is_manager(current_user):
        conditions.append(CallReview.rep_user_id == current_user.id)
    elif rep_user_id:
        conditions.append(CallReview.rep_user_id == rep_user_id)
    if review_status:
        conditions.append(CallReview.status == review_status)

    total = (await db.execute(select(func.count(CallReview.id)).where(*conditions))).scalar() or 0
    result = await db.execute(
        select(CallReview)
        .where(*conditions)
        .order_by(CallReview.call_started_at.desc().nullslast(), CallReview.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = result.scalars().all()

    evals = await _current_evaluations(db, [r.id for r in rows])
    calls = await _by_id(db, CallLog, [r.call_log_id for r in rows])
    users = await _by_id(db, User, [r.rep_user_id for r in rows])
    customer_names = await _customer_names(db, rows)

    items = []
    for r in rows:
        ev = evals.get(r.id)
        rep = users.get(r.rep_user_id)
        items.append(
            {
                "id": str(r.id),
                "status": r.status,
                "skip_reason": r.skip_reason,
                "error": r.error,
                "call": _call_dict(calls.get(r.call_log_id)),
                "lead_id": str(r.lead_id) if r.lead_id else None,
                "customer_name": customer_names.get(r.id),
                "rep": {"id": str(rep.id), "name": rep.full_name} if rep else None,
                "overall_score": ev.overall_score if ev else None,
                "ai_call_outcome": ev.ai_call_outcome if ev else None,
                "rubric_version": ev.rubric_version if ev else None,
                "has_transcript": bool(r.transcript),
            }
        )
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "auto_review_enabled": settings.call_review_auto_enabled,
        "can_manage": _is_manager(current_user),
    }


@router.get("/unreviewed-calls")
async def list_unreviewed_calls(
    limit: int = Query(25, ge=1, le=100),
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Recent recorded calls that have not been reviewed yet (for reviewing on demand)."""
    result = await db.execute(
        select(CallLog)
        .outerjoin(CallReview, CallReview.call_log_id == CallLog.id)
        .where(
            CallReview.id.is_(None),
            CallLog.status == CallStatus.COMPLETED,
            CallLog.recording_url.isnot(None),
        )
        .order_by(CallLog.started_at.desc())
        .limit(limit * 3)
    )
    calls = [c for c in result.scalars().all() if reviews.ineligibility_reason(c) is None][:limit]

    users = await _by_id(db, User, [c.answered_by or c.user_id for c in calls])
    customer_names = await _customer_names(db, calls)
    items = []
    for c in calls:
        rep = users.get(c.answered_by or c.user_id)
        items.append(
            {
                "call": _call_dict(c),
                "lead_id": str(c.lead_id) if c.lead_id else None,
                "customer_name": customer_names.get(c.id),
                "rep": {"id": str(rep.id), "name": rep.full_name} if rep else None,
            }
        )
    return {"items": items}


# ---------------------------------------------------------------- triggers --

@router.post("/calls/{call_log_id}/review", status_code=status.HTTP_202_ACCEPTED)
async def review_call(
    call_log_id: UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Queue a call for transcription and AI review now (works even when automatic review is off)."""
    call = (await db.execute(select(CallLog).where(CallLog.id == call_log_id))).scalar_one_or_none()
    if call is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Call not found")
    if not call.recording_url:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This call has no recording")

    review = await reviews.get_or_create_review(db, call)
    _mark_queued(review)
    await db.commit()
    background_tasks.add_task(reviews.process_call_review_background, call.id, force=True, manual=True)
    return {"review_id": str(review.id), "status": "queued"}


@router.post("/{review_id}/rerun", status_code=status.HTTP_202_ACCEPTED)
async def rerun_review(
    review_id: UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(deps.require_admin),
    db: AsyncSession = Depends(get_db),
):
    """
    Re-run a review: retries a failure, or re-scores a finished call with the
    current rubric. The existing transcript is reused; the previous evaluation is kept for audit.
    """
    review = (await db.execute(select(CallReview).where(CallReview.id == review_id))).scalar_one_or_none()
    if review is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Review not found")
    _mark_queued(review)
    await db.commit()
    background_tasks.add_task(reviews.process_call_review_background, review.call_log_id, force=True, manual=True)
    return {"review_id": str(review.id), "status": "queued"}


# ------------------------------------------------------------------- detail --

@router.get("/{review_id}")
async def get_call_review(
    review_id: UUID,
    current_user: User = Depends(deps.get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    """Full review: call details, transcript, AI evaluation, and the actual CRM outcome."""
    review = (await db.execute(select(CallReview).where(CallReview.id == review_id))).scalar_one_or_none()
    if review is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Review not found")
    if not _is_manager(current_user) and review.rep_user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    call = (await db.execute(select(CallLog).where(CallLog.id == review.call_log_id))).scalar_one_or_none()
    ev = (await _current_evaluations(db, [review.id])).get(review.id)
    rep = (await _by_id(db, User, [review.rep_user_id])).get(review.rep_user_id)
    customer_names = await _customer_names(db, [review])
    dealership = (await _by_id(db, Dealership, [review.dealership_id])).get(review.dealership_id)
    history_count = (
        await db.execute(select(func.count(CallEvaluation.id)).where(CallEvaluation.review_id == review.id))
    ).scalar() or 0

    return {
        "id": str(review.id),
        "status": review.status,
        "skip_reason": review.skip_reason,
        "error": review.error,
        "attempts": review.attempts,
        "can_manage": _is_manager(current_user),
        "call": _call_dict(call),
        "lead_id": str(review.lead_id) if review.lead_id else None,
        "customer_name": customer_names.get(review.id),
        "rep": {"id": str(rep.id), "name": rep.full_name} if rep else None,
        "dealership": {"id": str(dealership.id), "name": dealership.name} if dealership else None,
        "transcript": review.transcript or [],
        "transcript_provider": review.transcript_provider,
        "transcript_model": review.transcript_model,
        "evaluation": (
            {
                "id": str(ev.id),
                "overall_score": ev.overall_score,
                "category_scores": ev.category_scores,
                "ai_call_outcome": ev.ai_call_outcome,
                "rubric_version": ev.rubric_version,
                "llm_model": ev.llm_model,
                "prompt_version": ev.prompt_version,
                "created_at": ev.created_at.isoformat() if ev.created_at else None,
                **(ev.result or {}),
            }
            if ev
            else None
        ),
        "evaluation_count": history_count,
        # Real CRM data, kept separate from the AI's opinion of the call
        "crm_outcome": await reviews.get_crm_outcome(db, call) if call else None,
    }
