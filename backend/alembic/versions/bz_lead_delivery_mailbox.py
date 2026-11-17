"""Super-admin mailbox for partner lead emails.

Revision ID: bz_lead_delivery_mailbox
Revises: by_partner_store_profile
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "bz_lead_delivery_mailbox"
down_revision: Union[str, None] = "by_partner_store_profile"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "lead_delivery_mailbox",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("smtp_host", sa.String(length=255), nullable=False, server_default="smtp.office365.com"),
        sa.Column("smtp_port", sa.Integer(), nullable=False, server_default="587"),
        sa.Column("smtp_user", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("smtp_password_encrypted", sa.Text(), nullable=False, server_default=""),
        sa.Column("use_tls", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("use_ssl", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("from_name", sa.String(length=255), nullable=False, server_default="Carvaminos"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("lead_delivery_mailbox")
