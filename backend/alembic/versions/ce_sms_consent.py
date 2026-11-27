"""SMS consent, auto first text, and promotional broadcasts.

Revision ID: ce_sms_consent
Revises: cd_bdc_attention_progress
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "ce_sms_consent"
down_revision: Union[str, None] = "cd_bdc_attention_progress"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("customers", sa.Column("sms_inquiry_consent", sa.Boolean(), nullable=True))
    op.add_column("customers", sa.Column("sms_promo_consent", sa.Boolean(), nullable=True))
    op.add_column("customers", sa.Column("sms_consent_source", sa.String(length=50), nullable=True))
    op.add_column("customers", sa.Column("sms_consent_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("customers", sa.Column("sms_promo_confirmed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "customers",
        sa.Column("sms_opted_out", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("customers", sa.Column("sms_opted_out_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_customers_sms_promo_audience", "customers", ["sms_promo_consent", "sms_opted_out"])

    op.add_column(
        "dealership_twilio_configs",
        sa.Column("messaging_service_sid", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "dealership_twilio_configs",
        sa.Column("sms_auto_first_message_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "dealership_twilio_configs",
        sa.Column("sms_promo_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )

    op.add_column("sms_logs", sa.Column("category", sa.String(length=20), nullable=True))

    op.create_table(
        "sms_broadcasts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("dealership_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("dealerships.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="queued"),
        sa.Column("total_recipients", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("sent_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failed_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("skipped_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "sms_broadcast_recipients",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("broadcast_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("sms_broadcasts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("customer_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("customers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("lead_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("leads.id", ondelete="SET NULL"), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("sms_log_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("sms_logs.id", ondelete="SET NULL"), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("broadcast_id", "customer_id", name="uq_sms_broadcast_recipient"),
    )
    op.create_index("ix_sms_broadcast_recipients_pending", "sms_broadcast_recipients", ["status", "broadcast_id"])


def downgrade() -> None:
    op.drop_index("ix_sms_broadcast_recipients_pending", table_name="sms_broadcast_recipients")
    op.drop_table("sms_broadcast_recipients")
    op.drop_table("sms_broadcasts")
    op.drop_column("sms_logs", "category")
    op.drop_column("dealership_twilio_configs", "sms_promo_enabled")
    op.drop_column("dealership_twilio_configs", "sms_auto_first_message_enabled")
    op.drop_column("dealership_twilio_configs", "messaging_service_sid")
    op.drop_index("ix_customers_sms_promo_audience", table_name="customers")
    for col in (
        "sms_opted_out_at",
        "sms_opted_out",
        "sms_promo_confirmed_at",
        "sms_consent_at",
        "sms_consent_source",
        "sms_promo_consent",
        "sms_inquiry_consent",
    ):
        op.drop_column("customers", col)
