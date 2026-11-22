"""The mailbox that sends a lead to a partner store. Super admins set it in the portal."""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.timezone import utc_now
from app.db.database import Base


class LeadDeliveryMailbox(Base):
    __tablename__ = "lead_delivery_mailbox"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    smtp_host: Mapped[str] = mapped_column(String(255), nullable=False, default="smtp.office365.com")
    smtp_port: Mapped[int] = mapped_column(Integer, nullable=False, default=587)
    smtp_user: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    smtp_password_encrypted: Mapped[str] = mapped_column(Text, nullable=False, default="")
    use_tls: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    use_ssl: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    from_name: Mapped[str] = mapped_column(String(255), nullable=False, default="Carvamonos")
    graph_tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    graph_client_id: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    graph_client_secret_encrypted: Mapped[str] = mapped_column(Text, nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False
    )
