"""Daily BDC attention pass. Runs before 8 AM Eastern, and on a manual recheck."""
import logging
from uuid import UUID

from sqlalchemy import select

from app.core.permissions import UserRole
from app.db.database import async_session_maker
from app.models.user import User
from app.services.bdc_attention_service import run_attention_for_user

logger = logging.getLogger(__name__)


async def run_attention_for_user_id(user_id: str) -> None:
    async with async_session_maker() as db:
        user = await db.get(User, UUID(user_id))
        if user is None or not user.is_active or user.role != UserRole.BDC:
            return
        await run_attention_for_user(db, user)


async def run_bdc_morning_attention() -> None:
    """Check every active BDC agent's book. Scheduled for 7:15 AM America/New_York."""
    async with async_session_maker() as db:
        users = (
            await db.execute(
                select(User.id).where(User.role == UserRole.BDC, User.is_active.is_(True))
            )
        ).scalars().all()
        ids = [str(user_id) for user_id in users]
    logger.info("Morning BDC attention pass for %s agents", len(ids))
    for user_id in ids:
        try:
            await run_attention_for_user_id(user_id)
        except Exception:
            logger.exception("Morning attention failed for user %s", user_id)
