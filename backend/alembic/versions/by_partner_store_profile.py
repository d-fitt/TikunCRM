"""Partner store profile: range, recipients, inventory, lead channels.

Revision ID: by_partner_store_profile
Revises: bx_partner_store_campaigns
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "by_partner_store_profile"
down_revision: Union[str, None] = "bx_partner_store_campaigns"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("partner_stores", sa.Column("external_code", sa.String(length=50), nullable=True))
    op.add_column("partner_stores", sa.Column("monthly_leads_min", sa.Integer(), nullable=True))
    op.add_column("partner_stores", sa.Column("monthly_leads_max", sa.Integer(), nullable=True))
    op.create_unique_constraint(
        "uq_partner_stores_external_code", "partner_stores", ["external_code"]
    )

    op.create_table(
        "partner_store_recipients",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("partner_store_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["partner_store_id"], ["partner_stores.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("partner_store_id", "email", name="uq_partner_store_recipient_email"),
    )
    op.create_index(
        "ix_partner_store_recipients_store",
        "partner_store_recipients",
        ["partner_store_id"],
    )

    op.create_table(
        "partner_store_channels",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("partner_store_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("channel_type", sa.String(length=30), nullable=False),
        sa.Column("platform", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.ForeignKeyConstraint(["partner_store_id"], ["partner_stores.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "partner_store_id",
            "channel_type",
            "platform",
            "label",
            name="uq_partner_store_channel",
        ),
    )
    op.create_index(
        "ix_partner_store_channels_store",
        "partner_store_channels",
        ["partner_store_id"],
    )

    op.create_table(
        "partner_inventory_sources",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("partner_store_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("external_source_id", sa.String(length=50), nullable=True),
        sa.Column("source_name", sa.String(length=255), nullable=False),
        sa.Column("platforms", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["partner_store_id"], ["partner_stores.id"], ondelete="CASCADE"),
    )
    op.create_index(
        "ix_partner_inventory_sources_store",
        "partner_inventory_sources",
        ["partner_store_id"],
    )

    op.create_table(
        "partner_inventory_urls",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("inventory_source_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("inventory_type", sa.String(length=20), nullable=False),
        sa.ForeignKeyConstraint(
            ["inventory_source_id"],
            ["partner_inventory_sources.id"],
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "ix_partner_inventory_urls_source",
        "partner_inventory_urls",
        ["inventory_source_id"],
    )

    op.add_column(
        "lead_deliveries",
        sa.Column("sent_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_lead_deliveries_sent_by_user_id",
        "lead_deliveries",
        "users",
        ["sent_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_lead_deliveries_sent_by_user_id",
        "lead_deliveries",
        ["sent_by_user_id"],
    )
    op.execute(
        """
        DELETE FROM lead_deliveries
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY lead_id, partner_store_id
                           ORDER BY delivered_at DESC, id DESC
                       ) AS rn
                FROM lead_deliveries
            ) ranked
            WHERE rn > 1
        )
        """
    )
    op.create_unique_constraint(
        "uq_lead_delivery_lead_store",
        "lead_deliveries",
        ["lead_id", "partner_store_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_lead_delivery_lead_store", "lead_deliveries", type_="unique")
    op.drop_index("ix_lead_deliveries_sent_by_user_id", table_name="lead_deliveries")
    op.drop_constraint("fk_lead_deliveries_sent_by_user_id", "lead_deliveries", type_="foreignkey")
    op.drop_column("lead_deliveries", "sent_by_user_id")
    op.drop_index("ix_partner_inventory_urls_source", table_name="partner_inventory_urls")
    op.drop_table("partner_inventory_urls")
    op.drop_index("ix_partner_inventory_sources_store", table_name="partner_inventory_sources")
    op.drop_table("partner_inventory_sources")
    op.drop_index("ix_partner_store_channels_store", table_name="partner_store_channels")
    op.drop_table("partner_store_channels")
    op.drop_index("ix_partner_store_recipients_store", table_name="partner_store_recipients")
    op.drop_table("partner_store_recipients")
    op.drop_constraint("uq_partner_stores_external_code", "partner_stores", type_="unique")
    op.drop_column("partner_stores", "monthly_leads_max")
    op.drop_column("partner_stores", "monthly_leads_min")
    op.drop_column("partner_stores", "external_code")
