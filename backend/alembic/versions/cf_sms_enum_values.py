"""Add SMS_RECEIVED enum values to activitytype and notificationtype.

Revision ID: cf_sms_enum_values
Revises: ce_sms_consent
Create Date: 2026-11-27
"""
from alembic import op

revision = "cf_sms_enum_values"
down_revision = "ce_sms_consent"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE activitytype ADD VALUE IF NOT EXISTS 'SMS_RECEIVED'")
    op.execute("ALTER TYPE notificationtype ADD VALUE IF NOT EXISTS 'SMS_RECEIVED'")


def downgrade() -> None:
    # Postgres does not support removing values from an enum type.
    pass
