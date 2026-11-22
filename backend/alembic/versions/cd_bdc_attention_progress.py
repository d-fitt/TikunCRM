"""Progress for the shared BDC attention check.

Revision ID: cd_bdc_attention_progress
Revises: cc_bdc_attention_shared
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "cd_bdc_attention_progress"
down_revision: Union[str, None] = "cc_bdc_attention_shared"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("bdc_attention_snapshots", sa.Column("progress_done", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("bdc_attention_snapshots", sa.Column("progress_total", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("bdc_attention_snapshots", sa.Column("progress_label", sa.String(length=160), nullable=True))


def downgrade() -> None:
    op.drop_column("bdc_attention_snapshots", "progress_label")
    op.drop_column("bdc_attention_snapshots", "progress_total")
    op.drop_column("bdc_attention_snapshots", "progress_done")
