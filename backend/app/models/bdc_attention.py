"""One shared morning attention list for every BDC agent."""
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.database import Base

SHARED_ATTENTION_ID = "shared"


class BdcAttentionSnapshot(Base):
    """Latest AI pass over the whole book. Every BDC reads this same row."""

    __tablename__ = "bdc_attention_snapshots"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=SHARED_ATTENTION_ID)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="empty")
    model: Mapped[str] = mapped_column(String(64), nullable=False, default="gpt-4o-mini")
    generated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    scanned_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    attention_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    progress_done: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    progress_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    progress_label: Mapped[Optional[str]] = mapped_column(String(160), nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    items: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    claimed: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
