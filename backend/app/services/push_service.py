"""
Push Notification Service - FCM Only
Uses Firebase Cloud Messaging (FCM) HTTP V1 API for all push notifications.
"""
import asyncio
import logging
from typing import Optional, List, Dict, Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.fcm_token import FCMToken
from app.models.user import User

logger = logging.getLogger(__name__)


class PushService:
    """
    Service for sending push notifications via Firebase Cloud Messaging (FCM).
    
    Usage:
        push = PushService()
        await push.send_to_user(db, user_id, "Title", "Body", "/leads/123")
    """
    
    @property
    def is_configured(self) -> bool:
        """Check if FCM is configured"""
        return settings.is_fcm_configured
    
    async def send_to_user(
        self,
        db: AsyncSession,
        user_id: UUID,
        title: str,
        body: str,
        url: Optional[str] = None,
        icon: Optional[str] = None,
        tag: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None,
        ttl_seconds: Optional[int] = None,
    ) -> int:
        """
        Send push notification to all active FCM devices for a user.
        
        Args:
            db: Database session
            user_id: User ID to send to
            title: Notification title
            body: Notification body
            url: Optional URL to open on click
            icon: Optional icon URL (not used in FCM)
            tag: Optional notification tag
            data: Optional additional data
            ttl_seconds: Optional FCM webpush TTL (use ~35s for incoming calls)
            
        Returns:
            Number of successful sends
        """
        if not self.is_configured:
            logger.debug("FCM not configured - skipping push notification")
            return 0

        # Own session. Committing the caller's session here expired every
        # other user still waiting in the same notification loop, so only
        # the first recipient was delivered.
        del db
        from app.db.database import async_session_maker
        from app.services.fcm_service import fcm_service, InvalidFCMTokenError

        try:
            async with async_session_maker() as push_db:
                fcm_result = await push_db.execute(
                    select(FCMToken).where(
                        FCMToken.user_id == user_id,
                        FCMToken.is_active == True,
                    )
                )
                fcm_tokens = list(fcm_result.scalars().all())
                if not fcm_tokens:
                    logger.debug("No active FCM tokens for user %s", user_id)
                    return 0

                payloads = [(row.id, row.token) for row in fcm_tokens]

                async def _send_one(token_id: UUID, token_value: str):
                    try:
                        ok = await fcm_service.send(
                            token=token_value,
                            title=title,
                            body=body,
                            url=url,
                            tag=tag,
                            data=data,
                            ttl_seconds=ttl_seconds,
                        )
                        return token_id, "ok" if ok else "fail"
                    except InvalidFCMTokenError:
                        return token_id, "invalid"
                    except Exception as exc:
                        logger.warning(
                            "FCM send failed for user %s token %s: %s",
                            user_id,
                            token_id,
                            exc,
                        )
                        return token_id, "fail"

                outcomes = await asyncio.gather(
                    *[_send_one(token_id, token_value) for token_id, token_value in payloads]
                )
                by_id = {row.id: row for row in fcm_tokens}
                success_count = 0
                for token_id, outcome in outcomes:
                    row = by_id.get(token_id)
                    if row is None:
                        continue
                    if outcome == "ok":
                        row.mark_success()
                        success_count += 1
                    elif outcome == "invalid":
                        logger.info(
                            "Deleting invalid FCM token %s for user %s",
                            token_id,
                            user_id,
                        )
                        await push_db.delete(row)
                    else:
                        row.mark_failed()
                await push_db.commit()
        except Exception as e:
            logger.exception("FCM send_to_user error: %s", e)
            return 0

        logger.info(
            "Sent push to %s/%s FCM device(s) for user %s",
            success_count,
            len(fcm_tokens),
            user_id,
        )
        return success_count

    async def notify_incoming_call(
        self,
        db: AsyncSession,
        user_ids: List[UUID],
        *,
        from_number: str,
        lead_name: Optional[str] = None,
        lead_id: Optional[UUID] = None,
        call_sid: Optional[str] = None,
        call_log_id: Optional[UUID] = None,
    ) -> int:
        """High-priority push so agents see/hear a ring when the CRM tab is backgrounded."""
        who = lead_name or from_number or "Unknown caller"
        body = f"Incoming call from {who}"
        if lead_name and from_number:
            body = f"{lead_name} • {from_number}"
        url = f"/dashboard?incoming_call=1&lead_id={lead_id}" if lead_id else "/dashboard?incoming_call=1"
        tag = f"incoming-call-{call_sid}" if call_sid else "incoming-call"
        data = {
            "type": "incoming_call",
            "call_sid": call_sid or "",
            "call_log_id": str(call_log_id) if call_log_id else "",
            "lead_id": str(lead_id) if lead_id else "",
            "lead_name": lead_name or "",
            "from_number": from_number or "",
        }
        async def _one(uid: UUID) -> int:
            try:
                return await self.send_to_user(
                    db,
                    uid,
                    title="Incoming Call",
                    body=body,
                    url=url,
                    tag=tag,
                    data=data,
                    ttl_seconds=55,
                )
            except Exception as e:
                logger.warning("Incoming-call push failed for user %s: %s", uid, e)
                return 0

        counts = await asyncio.gather(*[_one(uid) for uid in user_ids])
        return sum(counts)
    
    async def send_to_users(
        self,
        db: AsyncSession,
        user_ids: List[UUID],
        title: str,
        body: str,
        url: Optional[str] = None,
        icon: Optional[str] = None,
        tag: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None,
        ttl_seconds: Optional[int] = None,
    ) -> Dict[str, int]:
        """
        Send push notification to multiple users via FCM.
        
        Returns:
            Dict with total_users, total_devices, and success_count
        """
        if not self.is_configured:
            return {"total_users": 0, "total_devices": 0, "success_count": 0}

        async def _one(uid: UUID) -> int:
            try:
                return await self.send_to_user(
                    db=db,
                    user_id=uid,
                    title=title,
                    body=body,
                    url=url,
                    icon=icon,
                    tag=tag,
                    data=data,
                    ttl_seconds=ttl_seconds,
                )
            except Exception as e:
                logger.warning("Push failed for user %s: %s", uid, e)
                return 0

        counts = await asyncio.gather(*[_one(uid) for uid in user_ids])
        success_count = sum(counts)

        # Count total FCM devices for response
        total_devices = 0
        try:
            from app.services.fcm_service import fcm_service
            if fcm_service.is_configured:
                r = await db.execute(
                    select(FCMToken).where(
                        FCMToken.user_id.in_(user_ids),
                        FCMToken.is_active == True
                    )
                )
                total_devices = len(r.scalars().all())
        except Exception:
            pass

        return {
            "total_users": len(user_ids),
            "total_devices": total_devices,
            "success_count": success_count
        }
    
    async def send_to_dealership(
        self,
        db: AsyncSession,
        dealership_id: UUID,
        title: str,
        body: str,
        url: Optional[str] = None,
        exclude_user_id: Optional[UUID] = None
    ) -> Dict[str, int]:
        """
        Send push notification to all users in a dealership via FCM.
        
        Args:
            db: Database session
            dealership_id: Dealership ID
            title: Notification title
            body: Notification body
            url: Optional URL to open
            exclude_user_id: Optional user ID to exclude
            
        Returns:
            Dict with total_users and success_count
        """
        if not self.is_configured:
            return {"total_users": 0, "success_count": 0}
        
        # Get all users in dealership
        query = select(User.id).where(
            User.dealership_id == dealership_id,
            User.is_active == True
        )
        if exclude_user_id:
            query = query.where(User.id != exclude_user_id)
        
        result = await db.execute(query)
        user_ids = [row[0] for row in result.fetchall()]
        
        if not user_ids:
            return {"total_users": 0, "success_count": 0}
        
        stats = await self.send_to_users(db, user_ids, title, body, url)
        return {
            "total_users": stats["total_users"],
            "success_count": stats["success_count"]
        }


# Singleton instance
push_service = PushService()
