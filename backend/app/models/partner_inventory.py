"""Vehicle inventory feeds for a partner store."""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.timezone import utc_now
from app.db.database import Base

INVENTORY_NEW = "new"
INVENTORY_USED = "used"
INVENTORY_CPO = "cpo"
INVENTORY_TYPES = frozenset({INVENTORY_NEW, INVENTORY_USED, INVENTORY_CPO})


class PartnerInventorySource(Base):
    __tablename__ = "partner_inventory_sources"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    partner_store_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("partner_stores.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    external_source_id: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    source_name: Mapped[str] = mapped_column(String(255), nullable=False)
    platforms: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=datetime.utcnow, nullable=False
    )


class PartnerInventoryUrl(Base):
    __tablename__ = "partner_inventory_urls"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    inventory_source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("partner_inventory_sources.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    url: Mapped[str] = mapped_column(Text, nullable=False)
    inventory_type: Mapped[str] = mapped_column(String(20), nullable=False)
