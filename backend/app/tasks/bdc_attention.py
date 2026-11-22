"""Daily shared BDC attention pass. One list for every agent."""
import logging

from sqlalchemy import select

from app.core.permissions import UserRole
from app.db.database import async_session_maker
from app.models.user import User
from app.services.bdc_attention_service import run_attention_for_user

logger = logging.getLogger(__name__)


async def run_shared_bdc_attention() -> None:
    async with async_session_maker() as db:
        user = (
            await db.execute(
                select(User).where(User.role == UserRole.BDC, User.is_active.is_(True)).limit(1)
            )
        ).scalar_one_or_none()
        if user is None:
            logger.info("No active BDC agent, skipping the shared attention pass")
            return
        await run_attention_for_user(db, user)


async def run_bdc_morning_attention() -> None:
    """One shared check at 7:15 AM America/New_York."""
    try:
        await run_shared_bdc_attention()
    except Exception:
        logger.exception("Morning attention failed")
