"""Add name, media_urls, filters, and scheduled_at to sms_broadcasts.

Revision ID: cg_sms_broadcast_advanced
Revises: cf_sms_enum_values
Create Date: 2026-11-27
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "cg_sms_broadcast_advanced"
down_revision = "cf_sms_enum_values"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sms_broadcasts", sa.Column("name", sa.String(160), nullable=True))
    op.add_column(
        "sms_broadcasts",
        sa.Column("media_urls", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
    )
    op.add_column(
        "sms_broadcasts",
        sa.Column("filters", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    op.add_column(
        "sms_broadcasts",
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sms_broadcasts", "scheduled_at")
    op.drop_column("sms_broadcasts", "filters")
    op.drop_column("sms_broadcasts", "media_urls")
    op.drop_column("sms_broadcasts", "name")
