import hashlib
import json
from datetime import datetime, timezone
from typing import List, Dict, Any


async def extract_schema_metadata(conn, dataset_id: str, schema_name: str) -> Dict[str, Any]:
    """Extract schema metadata - same as Node.js schema.ts"""
    tables_rows = await conn.fetch(
        """
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
        ORDER BY table_name
        """,
        schema_name
    )

    tables = []
    for t in tables_rows:
        table_name = t["table_name"]

        # Row count
        try:
            count_row = await conn.fetchrow(f'SELECT COUNT(*)::text as count FROM "{schema_name}"."{table_name}"')
            row_count = int(count_row["count"])
        except Exception:
            row_count = 0

        # Columns
        col_rows = await conn.fetch(
            """
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position
            """,
            schema_name, table_name
        )

        # Primary keys
        pk_rows = await conn.fetch(
            """
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
            """,
            schema_name, table_name
        )
        primary_keys = [pk["column_name"] for pk in pk_rows]

        # Foreign keys
        fk_rows = await conn.fetch(
            """
            SELECT kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2
            """,
            schema_name, table_name
        )
        fk_map = {r["column_name"]: {"targetTable": r["foreign_table_name"], "targetColumn": r["foreign_column_name"]} for r in fk_rows}

        columns = [
            {
                "name": c["column_name"],
                "dataType": c["data_type"].upper(),
                "isNullable": c["is_nullable"] == "YES",
                "isPrimaryKey": c["column_name"] in primary_keys,
                "foreignKey": fk_map.get(c["column_name"]),
            }
            for c in col_rows
        ]

        tables.append({
            "name": table_name,
            "rowCount": row_count,
            "rowCountType": "exact",
            "columns": columns,
            "primaryKeys": primary_keys,
        })

    # Fingerprint
    canonical = json.dumps({"schema": schema_name, "tables": [t["name"] for t in tables], "cols": [[c["name"] for c in t["columns"]] for t in tables]}, sort_keys=True)
    fingerprint = hashlib.sha256(canonical.encode()).hexdigest()[:16]

    return {
        "datasetId": dataset_id,
        "schemaName": schema_name,
        "tables": tables,
        "fingerprint": fingerprint,
        "extractedAt": datetime.now(timezone.utc).isoformat(),
    }
