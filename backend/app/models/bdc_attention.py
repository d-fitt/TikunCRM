"""Stored morning attention list for one BDC agent."""
import uuid
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.database import Base


class BdcAttentionSnapshot(Base):
    """Latest AI pass over this agent's book. One row per BDC user."""

    __tablename__ = "bdc_attention_snapshots"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="empty")
    model: Mapped[str] = mapped_column(String(64), nullable=False, default="gpt-4o-mini")
    generated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    scanned_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    attention_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    items: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
