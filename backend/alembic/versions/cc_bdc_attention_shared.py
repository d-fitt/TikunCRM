"""Shared BDC attention list. One row, not one per agent.

Revision ID: cc_bdc_attention_shared
Revises: cb_bdc_attention_snapshot
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "cc_bdc_attention_shared"
down_revision: Union[str, None] = "cb_bdc_attention_snapshot"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS bdc_attention_snapshots")
    op.create_table(
        "bdc_attention_snapshots",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="empty"),
        sa.Column("model", sa.String(length=64), nullable=False, server_default="gpt-4o-mini"),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("scanned_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("attention_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("items", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("claimed", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS bdc_attention_snapshots")
