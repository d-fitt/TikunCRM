"""
Single-company cleanup: remove the dead dealerships and their accounts.

Runs every step inside ONE transaction. Without --apply the transaction is
rolled back at the end, so the printed row counts are exact but nothing changes.

Steps:
  1. Merge duplicate accounts (same person, old dealership) into the active account.
  2. Move Kpacheco's open leads, upcoming appointments and their pending
     follow-ups to Kerelis, then archive Kpacheco.
  3. Archive every remaining salesperson / dealership-owner account (no login,
     history and authorship kept).
  4. Delete accounts that own nothing but notifications.
  5. Pin the remaining users to Carvaminos.
  6. Delete Ford Atlanta, Nissan and Toyota South Atlanta.

Usage (from backend/):
    python -m scripts.remove_dealership_concept            # dry run
    python -m scripts.remove_dealership_concept --apply    # commit
"""
from __future__ import annotations

import argparse
import sys

from sqlalchemy import create_engine, text

from scripts.carvaminos_consolidation import _sync_database_url

CARVAMINOS_ID = "00000000-0000-4000-a000-000000000001"
DEAD_DEALERSHIP_IDS = [
    "35a0038c-7e82-4f37-9c86-b0a1ad34e89c",  # Ford Atlanta
    "39bd6d10-036b-44ed-a55b-8aa55b4cb4dc",  # Nissan
    "c6e827d5-cd6b-43a7-b6ed-cc45e628ed62",  # Toyota South Atlanta
]

# old account -> account that keeps the history
MERGES = {
    "96b5c18f-a122-4eeb-85f0-cdd590f16cff": "b2d1d789-fb1e-402f-97be-27d66fb9d8cb",  # dheeraj@ Toyota -> Carvaminos
    "79186b6a-1b66-4bbc-a699-d6b5e7b103b8": "e0360326-d452-4850-b293-af8c9dac1c16",  # jbrown@ Ford -> Carvaminos
    "27b9b2ae-ce39-439e-9c6e-95d097049c8b": "e0360326-d452-4850-b293-af8c9dac1c16",  # jbrown@ Toyota -> Carvaminos
    "a36daba1-445b-4989-9285-46386988ddcd": "e0360326-d452-4850-b293-af8c9dac1c16",  # jbrown@ old BDC -> Carvaminos
    "6632c577-45ca-4a6a-918c-25e39a1cb5f1": "9141ce12-5859-4827-b1fd-b52a02c3c184",  # Miguel Toyota admin -> Carvaminos BDC
}

KPACHECO_ID = "103e7e87-d937-4636-bbd7-bfb3a78a0b6a"
KERELIS_ID = "c8d4fe47-948a-40f2-9d50-12998cdfc7c0"

JUNK_EMAILS = [
    "jbrownnn@tikuntech.com",
    "atlerickllc@gmail.com",
    "mgarcia@toyotasouthatlanta.com",
    "test1@gmail.com",
    "tikuntest@gmail.com",
    "amojica@toyotasouthatlanta.com",
    "ford@fordatlanta.com",
    "nissan@tikuntech.com",
]

# Per-account rows that make no sense on another account; dropped instead of moved.
DROP_ON_MERGE = {
    "notifications",
    "fcm_tokens",
    "password_reset_tokens",
    "softphone_presence",
    "user_dealership_access",
}


def _fk_columns(conn, target_table: str) -> list[tuple[str, str]]:
    rows = conn.execute(
        text("""
            SELECT tc.table_name, kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = 'public'
              AND ccu.table_name = :target
            ORDER BY 1, 2
        """),
        {"target": target_table},
    ).fetchall()
    return [(r[0], r[1]) for r in rows]


def _run(conn, sql: str, params: dict, label: str) -> int:
    n = conn.execute(text(sql), params).rowcount or 0
    if n:
        print(f"    {label}: {n}")
    return n


def merge_accounts(conn, user_fks: list[tuple[str, str]]) -> None:
    print("\n[1] Merge duplicate accounts into the active account")
    for src, dst in MERGES.items():
        row = conn.execute(text("SELECT email FROM users WHERE id = :id"), {"id": src}).fetchone()
        if not row:
            print(f"  {src[:8]}… already gone")
            continue
        print(f"  {row[0]} ({src[:8]}… -> {dst[:8]}…)")
        for table, column in user_fks:
            if table == "users":
                continue
            if table in DROP_ON_MERGE:
                _run(conn, f'DELETE FROM "{table}" WHERE "{column}" = :src',
                     {"src": src}, f"dropped {table}.{column}")
            elif table == "partner_bdc_agents":
                _run(conn, f"""
                    DELETE FROM partner_bdc_agents a WHERE a.{column} = :src
                      AND EXISTS (SELECT 1 FROM partner_bdc_agents b
                                  WHERE b.{column} = :dst AND b.partner_store_id = a.partner_store_id)
                """, {"src": src, "dst": dst}, "dropped duplicate partner_bdc_agents")
                _run(conn, f'UPDATE "{table}" SET "{column}" = :dst WHERE "{column}" = :src',
                     {"src": src, "dst": dst}, f"moved {table}.{column}")
            elif table == "time_entries":
                _run(conn, """
                    UPDATE time_entries SET clock_out_at = clock_in_at
                    WHERE user_id = :src AND clock_out_at IS NULL
                """, {"src": src}, "closed open time_entries")
                _run(conn, f'UPDATE "{table}" SET "{column}" = :dst WHERE "{column}" = :src',
                     {"src": src, "dst": dst}, f"moved {table}.{column}")
            else:
                _run(conn, f'UPDATE "{table}" SET "{column}" = :dst WHERE "{column}" = :src',
                     {"src": src, "dst": dst}, f"moved {table}.{column}")
        _run(conn, "DELETE FROM users WHERE id = :src", {"src": src}, "deleted account")


def hand_over_kpacheco(conn) -> None:
    print("\n[2] Kpacheco -> Kerelis")
    params = {"src": KPACHECO_ID, "dst": KERELIS_ID}
    moved_leads = conn.execute(
        text("UPDATE leads SET assigned_to = :dst WHERE assigned_to = :src RETURNING id"),
        params,
    ).fetchall()
    print(f"    leads reassigned: {len(moved_leads)}")
    if moved_leads:
        _run(conn, """
            UPDATE follow_ups SET assigned_to = :dst
            WHERE assigned_to = :src AND status = 'PENDING' AND lead_id = ANY(:lead_ids)
        """, {**params, "lead_ids": [r[0] for r in moved_leads]}, "pending follow-ups on those leads")
    _run(conn, """
        UPDATE appointments SET assigned_to = :dst
        WHERE assigned_to = :src AND status IN ('scheduled', 'confirmed', 'rescheduled')
          AND scheduled_at >= NOW()
    """, params, "upcoming appointments")
    _run(conn, "UPDATE users SET is_active = false WHERE id = :src", {"src": KPACHECO_ID},
         "Kpacheco archived")


def archive_legacy_roles(conn) -> None:
    print("\n[3] Archive remaining salesperson / dealership-owner accounts")
    rows = conn.execute(text("""
        UPDATE users SET is_active = false
        WHERE role IN ('SALESPERSON', 'DEALERSHIP_OWNER') AND is_active
        RETURNING email
    """)).fetchall()
    print(f"    newly archived: {len(rows)} {[r[0] for r in rows]}")
    total = conn.execute(text(
        "SELECT COUNT(*) FROM users WHERE role IN ('SALESPERSON', 'DEALERSHIP_OWNER')"
    )).scalar()
    print(f"    archived legacy-role accounts kept for history: {total}")


def delete_junk(conn) -> None:
    print("\n[4] Delete accounts that own nothing but notifications")
    rows = conn.execute(
        text("DELETE FROM users WHERE lower(email) = ANY(:emails) AND NOT is_active RETURNING email"),
        {"emails": JUNK_EMAILS},
    ).fetchall()
    print(f"    deleted: {len(rows)} {[r[0] for r in rows]}")


def pin_users(conn) -> None:
    print("\n[5] Pin remaining users to Carvaminos")
    rows = conn.execute(
        text("""
            UPDATE users SET dealership_id = :cid
            WHERE dealership_id IS DISTINCT FROM :cid
            RETURNING email, role, is_active
        """),
        {"cid": CARVAMINOS_ID},
    ).fetchall()
    for r in rows:
        print(f"    {r[0]} ({r[1]}, {'active' if r[2] else 'inactive'})")


def delete_dealerships(conn) -> None:
    print("\n[6] Delete the dead dealerships")
    ids = {"ids": DEAD_DEALERSHIP_IDS}
    for table, column in _fk_columns(conn, "dealerships"):
        n = conn.execute(
            text(f'SELECT COUNT(*) FROM "{table}" WHERE "{column}" = ANY(CAST(:ids AS uuid[]))'),
            ids,
        ).scalar()
        if n:
            print(f"    still referencing ({table}.{column}): {n}")
    rows = conn.execute(
        text("DELETE FROM dealerships WHERE id = ANY(CAST(:ids AS uuid[])) RETURNING name"),
        ids,
    ).fetchall()
    print(f"    deleted: {[r[0].strip() for r in rows]}")


def summary(conn) -> None:
    print("\n[after] Users")
    for r in conn.execute(text("""
        SELECT role, is_active, COUNT(*) FROM users GROUP BY 1, 2 ORDER BY 1, 2 DESC
    """)).fetchall():
        print(f"    {r[0]:17} {'active' if r[1] else 'archived/inactive':18} {r[2]}")
    print("[after] Dealerships:", [r[0] for r in conn.execute(text("SELECT name FROM dealerships")).fetchall()])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="Commit the changes (default: dry run)")
    args = parser.parse_args()

    from app.core.config import settings

    engine = create_engine(
        _sync_database_url(settings.database_url),
        connect_args={"sslmode": "require"},
    )
    with engine.connect() as conn:
        conn.execute(text("SET statement_timeout TO 0"))
        conn.execute(text("SET lock_timeout TO '30s'"))
        user_fks = _fk_columns(conn, "users")

        merge_accounts(conn, user_fks)
        hand_over_kpacheco(conn)
        archive_legacy_roles(conn)
        delete_junk(conn)
        pin_users(conn)
        delete_dealerships(conn)
        summary(conn)

        if args.apply:
            conn.commit()
            print("\nCOMMITTED")
        else:
            conn.rollback()
            print("\nDRY RUN — rolled back, nothing changed. Re-run with --apply to commit.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
