"""Microsoft Graph credentials for partner lead email.

Revision ID: ca_lead_delivery_graph
Revises: bz_lead_delivery_mailbox
"""
from typing import Sequence, Union

from alembic import op

revision: str = "ca_lead_delivery_graph"
down_revision: Union[str, None] = "bz_lead_delivery_mailbox"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE lead_delivery_mailbox ADD COLUMN IF NOT EXISTS graph_tenant_id VARCHAR(64) NOT NULL DEFAULT ''")
    op.execute("ALTER TABLE lead_delivery_mailbox ADD COLUMN IF NOT EXISTS graph_client_id VARCHAR(64) NOT NULL DEFAULT ''")
    op.execute("ALTER TABLE lead_delivery_mailbox ADD COLUMN IF NOT EXISTS graph_client_secret_encrypted TEXT NOT NULL DEFAULT ''")


def downgrade() -> None:
    op.drop_column("lead_delivery_mailbox", "graph_client_secret_encrypted")
    op.drop_column("lead_delivery_mailbox", "graph_client_id")
    op.drop_column("lead_delivery_mailbox", "graph_tenant_id")
