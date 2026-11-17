"""
Add partner_stores table + lead partner columns if missing.

Run this FIRST on production when leads/follow-ups APIs return 500
because the backend expects columns that migrations haven't applied yet.

Usage (from backend/):
    python -m scripts.ensure_partner_schema
"""
from __future__ import annotations

import sys

from sqlalchemy import create_engine, text

from scripts.carvaminos_consolidation import _sync_database_url


def ensure_partner_schema(conn) -> None:
    """Idempotent — safe to run multiple times."""
    conn.execute(text("SET statement_timeout TO 0"))

    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS partner_stores (
            id UUID PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            brand VARCHAR(100),
            address TEXT,
            city VARCHAR(100),
            state VARCHAR(100),
            country VARCHAR(100) DEFAULT 'US',
            postal_code VARCHAR(20),
            phone VARCHAR(20),
            email VARCHAR(255),
            website VARCHAR(255),
            contact_person VARCHAR(255),
            notes TEXT,
            is_active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_partner_stores_brand ON partner_stores (brand)"
    ))

    conn.execute(text("""
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS interested_brand VARCHAR(100)
    """))
    conn.execute(text("""
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS partner_store_id UUID
    """))
    conn.execute(text("""
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS partner_connected_at TIMESTAMPTZ
    """))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_leads_interested_brand ON leads (interested_brand)"
    ))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_leads_partner_store_id ON leads (partner_store_id)"
    ))

    conn.execute(text("""
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS sold_partner_store_id UUID
    """))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_leads_sold_partner_store_id ON leads (sold_partner_store_id)"
    ))

    fk_exists = conn.execute(text("""
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_partner_store_id'
    """)).fetchone()
    if not fk_exists:
        conn.execute(text("""
            ALTER TABLE leads
            ADD CONSTRAINT fk_leads_partner_store_id
            FOREIGN KEY (partner_store_id) REFERENCES partner_stores (id)
            ON DELETE SET NULL
        """))

    sold_fk_exists = conn.execute(text("""
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_sold_partner_store_id'
    """)).fetchone()
    if not sold_fk_exists:
        conn.execute(text("""
            ALTER TABLE leads
            ADD CONSTRAINT fk_leads_sold_partner_store_id
            FOREIGN KEY (sold_partner_store_id) REFERENCES partner_stores (id)
            ON DELETE SET NULL
        """))

    conn.execute(text("""
        UPDATE leads
        SET sold_partner_store_id = partner_store_id
        WHERE sold_partner_store_id IS NULL
          AND partner_store_id IS NOT NULL
          AND (outcome = 'converted' OR converted_at IS NOT NULL)
    """))

    conn.execute(text("""
        ALTER TABLE partner_stores ADD COLUMN IF NOT EXISTS external_code VARCHAR(50)
    """))
    conn.execute(text("""
        ALTER TABLE partner_stores ADD COLUMN IF NOT EXISTS monthly_leads_min INTEGER
    """))
    conn.execute(text("""
        ALTER TABLE partner_stores ADD COLUMN IF NOT EXISTS monthly_leads_max INTEGER
    """))
    conn.execute(text("""
        ALTER TABLE lead_deliveries ADD COLUMN IF NOT EXISTS sent_by_user_id UUID
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS partner_store_recipients (
            id UUID PRIMARY KEY,
            partner_store_id UUID NOT NULL REFERENCES partner_stores (id) ON DELETE CASCADE,
            email VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_partner_store_recipient_email UNIQUE (partner_store_id, email)
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS partner_store_channels (
            id UUID PRIMARY KEY,
            partner_store_id UUID NOT NULL REFERENCES partner_stores (id) ON DELETE CASCADE,
            channel_type VARCHAR(30) NOT NULL,
            platform VARCHAR(100) NOT NULL DEFAULT '',
            label VARCHAR(255) NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT true,
            CONSTRAINT uq_partner_store_channel UNIQUE (partner_store_id, channel_type, platform, label)
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS partner_inventory_sources (
            id UUID PRIMARY KEY,
            partner_store_id UUID NOT NULL REFERENCES partner_stores (id) ON DELETE CASCADE,
            external_source_id VARCHAR(50),
            source_name VARCHAR(255) NOT NULL,
            platforms JSONB NOT NULL DEFAULT '[]',
            enabled BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS partner_inventory_urls (
            id UUID PRIMARY KEY,
            inventory_source_id UUID NOT NULL REFERENCES partner_inventory_sources (id) ON DELETE CASCADE,
            url TEXT NOT NULL,
            inventory_type VARCHAR(20) NOT NULL
        )
    """))
    conn.execute(text("""
        CREATE TABLE IF NOT EXISTS lead_delivery_mailbox (
            id UUID PRIMARY KEY,
            smtp_host VARCHAR(255) NOT NULL DEFAULT 'smtp.office365.com',
            smtp_port INTEGER NOT NULL DEFAULT 587,
            smtp_user VARCHAR(255) NOT NULL DEFAULT '',
            smtp_password_encrypted TEXT NOT NULL DEFAULT '',
            use_tls BOOLEAN NOT NULL DEFAULT true,
            use_ssl BOOLEAN NOT NULL DEFAULT false,
            from_name VARCHAR(255) NOT NULL DEFAULT 'Carvaminos',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """))


def main() -> int:
    from app.core.config import settings

    url = _sync_database_url(settings.database_url)
    print("Ensuring partner_stores schema…")
    engine = create_engine(
        url,
        connect_args={"connect_timeout": 60, "options": "-c statement_timeout=0"},
    )
    try:
        with engine.connect() as conn:
            ensure_partner_schema(conn)
            conn.commit()
        print("✓ partner_stores table and lead columns are present")
        print("\nRestart the backend, then run consolidation if needed:")
        print("  python -m scripts.carvaminos_consolidation")
        return 0
    except Exception as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
