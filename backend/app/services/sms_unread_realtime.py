"""Push the SMS unread total over the existing websocket. Sidebar and header share it."""
import logging
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.access_scope import get_accessible_dealership_ids
from app.core.permissions import UserRole
from app.core.websocket_manager import ws_manager
from app.models.user import User
from app.services.sms_conversation_service import SMSConversationService

logger = logging.getLogger(__name__)


async def sms_unread_count_for_user(db: AsyncSession, user: User) -> int:
    service = SMSConversationService(db)
    if user.role == UserRole.SALESPERSON:
        return await service.get_unread_count(user_id=user.id)
    if user.role in (UserRole.DEALERSHIP_ADMIN, UserRole.DEALERSHIP_OWNER):
        return await service.get_unread_count(dealership_id=user.dealership_id)
    if user.role == UserRole.BDC:
        dealership_ids = await get_accessible_dealership_ids(db, user)
        return await service.get_unread_count(dealership_ids=dealership_ids)
    return await service.get_unread_count()


async def push_sms_unread_to_user(db: AsyncSession, user: User) -> None:
    count = await sms_unread_count_for_user(db, user)
    await ws_manager.send_to_user(
        str(user.id),
        {"type": "sms:unread", "payload": {"count": count}},
    )


async def push_sms_unread_for_dealership(db: AsyncSession, dealership_id: str | None) -> None:
    """Recompute each connected user's own total and send it. One number, both badges."""
    if not dealership_id:
        return
    user_ids = ws_manager.user_ids_for_dealership(str(dealership_id))
    if not user_ids:
        return
    try:
        ids = [UUID(user_id) for user_id in user_ids]
    except ValueError:
        logger.warning("sms unread push skipped: bad user id in dealership %s", dealership_id)
        return
    result = await db.execute(select(User).where(User.id.in_(ids)))
    for user in result.scalars():
        try:
            await push_sms_unread_to_user(db, user)
        except Exception as exc:
            logger.warning("sms unread push failed for user %s: %s", user.id, exc)
