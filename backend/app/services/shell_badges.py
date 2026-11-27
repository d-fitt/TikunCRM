"""One snapshot of the sidebar and header counts, pushed over the websocket.

The shell does not poll these. Connect sends the current numbers. Later lead,
appointment, follow-up, and call changes send a fresh snapshot after a short
pause so a burst of updates becomes one recount, not one API call per event.
"""
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

import pytz
from sqlalchemy import and_, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.access_scope import apply_dealership_scope_to_lead_query, get_accessible_dealership_ids
from app.core.permissions import UserRole
from app.core.timezone import utc_now
from app.core.websocket_manager import ws_manager
from app.db.database import async_session_maker
from app.models.activity import Activity
from app.models.appointment import Appointment, AppointmentStatus
from app.models.call_log import CallDirection, CallLog, CallStatus
from app.models.follow_up import FollowUp, FollowUpStatus
from app.models.lead import Lead
from app.models.lead_stage import LeadStage
from app.models.user import User
from app.services.notification_service import NotificationService
from app.services.sms_unread_realtime import sms_unread_count_for_user
from app.services.whatsapp_conversation_service import WhatsAppConversationService
from app.utils.timezone import DEFAULT_DEALERSHIP_TIMEZONE, resolve_dealership_timezone

logger = logging.getLogger(__name__)

_MISSED_STATUSES = (
    CallStatus.NO_ANSWER,
    CallStatus.BUSY,
    CallStatus.FAILED,
    CallStatus.CANCELED,
)

_push_task: Optional[asyncio.Task] = None


def _today_range():
    tz = pytz.timezone(resolve_dealership_timezone(DEFAULT_DEALERSHIP_TIMEZONE))
    local = utc_now().astimezone(tz)
    start = tz.localize(datetime(local.year, local.month, local.day))
    tomorrow = local.date() + timedelta(days=1)
    end = tz.localize(datetime(tomorrow.year, tomorrow.month, tomorrow.day))
    return start.astimezone(pytz.UTC), end.astimezone(pytz.UTC)


async def _count(db: AsyncSession, query) -> int:
    return int((await db.execute(query)).scalar() or 0)


async def shell_badges_for_user(db: AsyncSession, user: User) -> dict:
    accessible_ids = await get_accessible_dealership_ids(db, user)
    start_of_day, start_of_tomorrow = _today_range()

    fresh_subq = (
        select(Activity.lead_id)
        .where(Activity.lead_id.isnot(None))
        .group_by(Activity.lead_id)
        .having(func.count(Activity.id) == 1)
    )
    fresh_q = (
        select(func.count())
        .select_from(Lead)
        .where(Lead.assigned_to.is_(None), Lead.id.in_(fresh_subq))
    )
    fresh_q = apply_dealership_scope_to_lead_query(fresh_q, accessible_ids, Lead)

    unassigned_q = select(func.count()).select_from(Lead).where(Lead.assigned_to.is_(None))
    unassigned_q = apply_dealership_scope_to_lead_query(unassigned_q, accessible_ids, Lead)

    review_q = (
        select(func.count())
        .select_from(Lead)
        .join(LeadStage, Lead.stage_id == LeadStage.id)
        .where(LeadStage.name == "manager_review")
    )
    review_q = apply_dealership_scope_to_lead_query(review_q, accessible_ids, Lead)

    if user.role == UserRole.SALESPERSON:
        appt_scope = Appointment.assigned_to == user.id
    elif accessible_ids is None:
        appt_scope = literal(True)
    elif accessible_ids:
        appt_scope = Appointment.dealership_id.in_(accessible_ids)
    else:
        appt_scope = literal(False)

    appointments_q = select(func.count(Appointment.id)).where(
        and_(
            appt_scope,
            Appointment.scheduled_at >= start_of_day,
            Appointment.scheduled_at < start_of_tomorrow,
            Appointment.status.in_([AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED]),
        )
    )
    follow_q = (
        select(func.count(FollowUp.id))
        .join(Lead, FollowUp.lead_id == Lead.id)
        .where(
            FollowUp.scheduled_at < utc_now(),
            FollowUp.status == FollowUpStatus.PENDING,
        )
    )
    follow_q = apply_dealership_scope_to_lead_query(follow_q, accessible_ids, Lead)
    if user.role == UserRole.SALESPERSON:
        follow_q = follow_q.where(FollowUp.assigned_to == user.id)

    missed_q = select(func.count(CallLog.id)).where(
        CallLog.direction == CallDirection.INBOUND,
        CallLog.status.in_(_MISSED_STATUSES),
        or_(
            CallLog.meta_data["missed_seen_at"].astext.is_(None),
            CallLog.meta_data["missed_callback_cleared_at"].astext.is_(None),
        ),
    )
    if user.role == UserRole.SALESPERSON:
        assigned = select(Lead.id).where(Lead.assigned_to == user.id)
        missed_q = missed_q.where((CallLog.user_id == user.id) | (CallLog.lead_id.in_(assigned)))
    elif user.role in (UserRole.DEALERSHIP_ADMIN, UserRole.DEALERSHIP_OWNER, UserRole.BDC):
        if user.dealership_id:
            missed_q = missed_q.where(CallLog.dealership_id == user.dealership_id)

    wa_user_id = user.id if user.role == UserRole.SALESPERSON else None
    wa_dealership_id = (
        user.dealership_id
        if user.role in (UserRole.DEALERSHIP_ADMIN, UserRole.DEALERSHIP_OWNER)
        else None
    )

    notifications = await NotificationService(db).get_unread_count(user.id)
    sms = await sms_unread_count_for_user(db, user)
    whatsapp = await WhatsAppConversationService(db).get_unread_count(
        user_id=wa_user_id,
        dealership_id=wa_dealership_id,
    )

    return {
        "appointments": await _count(db, appointments_q),
        "follow_ups": await _count(db, follow_q),
        "unassigned": await _count(db, unassigned_q),
        "manager_review": await _count(db, review_q),
        "notifications": notifications,
        "whatsapp_unread": whatsapp,
        "sms_unread": sms,
        "fresh_leads": await _count(db, fresh_q),
        "missed_calls": await _count(db, missed_q),
    }


async def push_shell_badges(db: AsyncSession, user: User) -> None:
    counts = await shell_badges_for_user(db, user)
    await ws_manager.send_to_user(
        str(user.id),
        {"type": "shell:badges", "payload": counts},
    )


def schedule_shell_badges_push() -> None:
    """Coalesce a burst of lead/call changes into one recount for whoever is connected."""
    global _push_task
    if _push_task and not _push_task.done():
        return

    async def _run() -> None:
        try:
            await asyncio.sleep(0.8)
            user_ids = ws_manager.get_connected_users()
            if not user_ids:
                return
            async with async_session_maker() as db:
                result = await db.execute(
                    select(User).where(User.id.in_([UUID(uid) for uid in user_ids]), User.is_active.is_(True))
                )
                for user in result.scalars():
                    try:
                        await push_shell_badges(db, user)
                    except Exception as exc:
                        logger.warning("shell badges push failed for %s: %s", user.id, exc)
        except Exception as exc:
            logger.warning("shell badges push failed: %s", exc)

    _push_task = asyncio.create_task(_run())
