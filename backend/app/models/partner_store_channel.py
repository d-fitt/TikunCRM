"""Where a partner store's leads come from, other than a CRM campaign.

Campaigns live in partner_store_campaigns. This table is marketplaces,
websites, and other named origins. A store has a list of them.
"""
import uuid

from sqlalchemy import Boolean, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.database import Base

CHANNEL_MARKETPLACE = "marketplace"
CHANNEL_WEBSITE = "website"
CHANNEL_OTHER = "other"
CHANNEL_TYPES = frozenset({CHANNEL_MARKETPLACE, CHANNEL_WEBSITE, CHANNEL_OTHER})


class PartnerStoreChannel(Base):
    __tablename__ = "partner_store_channels"
    __table_args__ = (
        UniqueConstraint(
            "partner_store_id",
            "channel_type",
            "platform",
            "label",
            name="uq_partner_store_channel",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    partner_store_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("partner_stores.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    channel_type: Mapped[str] = mapped_column(String(30), nullable=False)
    platform: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
