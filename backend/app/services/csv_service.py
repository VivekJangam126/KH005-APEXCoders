"""
CSV Service - Fast CSV parsing and bulk PostgreSQL import
"""
import csv
import io
import hashlib
import re
from typing import List, Dict, Any


def sanitize_identifier(name: str) -> str:
    cleaned = re.sub(r'[^a-z0-9_]', '_', name.strip().lower())
    cleaned = re.sub(r'^_+|_+$', '', cleaned)
    cleaned = re.sub(r'_+', '_', cleaned)
    if not cleaned or cleaned[0].isdigit():
        cleaned = 'col_' + cleaned
    return cleaned[:60]


def infer_type(values: List[str]) -> str:
    """Infer PostgreSQL type from a list of string values."""
    if not values:
        return "TEXT"

    def is_bigint(v):
        return re.fullmatch(r'-?[0-9]+', v) is not None

    def is_numeric(v):
        return re.fullmatch(r'-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?', v) is not None

    def is_bool(v):
        return v.lower() in ("true", "false", "t", "f", "yes", "no", "1", "0")

    def is_date(v):
        return bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', v))

    current = "BIGINT"
    for v in values:
        if not v or v.lower() in ("null", "n/a", ""):
            continue
        if current == "BIGINT":
            # Leading zeros indicate string (e.g. zip codes)
            if re.match(r'^0[0-9]', v):
                current = "TEXT"
                break
            if not is_bigint(v):
                current = "NUMERIC"
        if current == "NUMERIC":
            if not is_numeric(v):
                current = "BOOLEAN"
        if current == "BOOLEAN":
            if not is_bool(v):
                current = "DATE"
        if current == "DATE":
            if not is_date(v):
                current = "TEXT"
                break
    return current


def parse_csv_bytes(data: bytes, filename: str) -> Dict[str, Any]:
    """Parse CSV bytes and return column info + all rows."""
    checksum = hashlib.sha256(data).hexdigest()
    text = data.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))

    if not reader.fieldnames:
        raise ValueError("CSV has no headers")

    raw_headers = list(reader.fieldnames)
    if len(raw_headers) > 200:
        raise ValueError(f"CSV exceeds 200 column limit ({len(raw_headers)} found)")

    # Sanitize and deduplicate headers
    seen: Dict[str, int] = {}
    columns = []
    for i, h in enumerate(raw_headers):
        raw = h.strip() or f"column_{i+1}"
        internal = sanitize_identifier(raw)
        count = seen.get(internal, 0)
        seen[internal] = count + 1
        if count > 0:
            internal = f"{internal}_{count + 1}"
        columns.append({
            "originalName": raw,
            "internalName": internal,
            "detectedType": "TEXT",
            "isNullable": False,
        })

    # Read all rows
    all_rows_raw = list(reader)
    if len(all_rows_raw) > 100_000:
        raise ValueError(f"CSV exceeds 100,000 row limit ({len(all_rows_raw)} found)")

    # Collect sample values for type inference (up to 100 per column)
    col_values: List[List[str]] = [[] for _ in columns]
    for row in all_rows_raw:
        for i, col in enumerate(columns):
            val = row.get(raw_headers[i], "")
            if val and val.lower() not in ("null", "n/a") and len(col_values[i]) < 100:
                col_values[i].append(str(val).strip())

    # Infer types and nullability
    for i, col in enumerate(columns):
        col["detectedType"] = infer_type(col_values[i])
        col["isNullable"] = any(
            not row.get(raw_headers[i], "").strip()
            or row.get(raw_headers[i], "").lower() in ("null", "n/a")
            for row in all_rows_raw
        )

    def cast_value(val: str, col_type: str):
        v = (val or "").strip()
        if not v or v.lower() in ("null", "n/a"):
            return None
        if col_type == "BIGINT":
            try:
                return int(v)
            except Exception:
                return None
        if col_type == "NUMERIC":
            try:
                return float(v)
            except Exception:
                return None
        if col_type == "BOOLEAN":
            return v.lower() in ("true", "t", "yes", "1")
        return v

    parsed_rows = []
    for row in all_rows_raw:
        obj = {}
        for i, col in enumerate(columns):
            raw_val = row.get(raw_headers[i], "")
            obj[col["internalName"]] = cast_value(raw_val, col["detectedType"])
        parsed_rows.append(obj)

    return {
        "checksum": checksum,
        "totalRows": len(parsed_rows),
        "totalColumns": len(columns),
        "columns": columns,
        "previewRows": parsed_rows[:20],
        "allRows": parsed_rows,
        "issues": [],
    }


async def create_and_populate_table(
    conn,
    schema: str,
    table_name: str,
    columns: List[Dict],
    rows: List[Dict],
) -> int:
    """Create schema/table and bulk insert rows."""
    await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
    await conn.execute(f'DROP TABLE IF EXISTS "{schema}"."{table_name}" CASCADE')

    col_defs = ", ".join(
        f'"{c["internalName"]}" {c["detectedType"]} NULL'
        for c in columns
    )
    await conn.execute(f'CREATE TABLE "{schema}"."{table_name}" ({col_defs})')

    if not rows:
        return 0

    col_names = [c["internalName"] for c in columns]
    col_list = ", ".join(f'"{n}"' for n in col_names)
    placeholders = ", ".join(f"${i+1}" for i in range(len(col_names)))
    insert_sql = f'INSERT INTO "{schema}"."{table_name}" ({col_list}) VALUES ({placeholders})'

    records = [tuple(row.get(n) for n in col_names) for row in rows]

    chunk_size = 1000
    for i in range(0, len(records), chunk_size):
        chunk = records[i : i + chunk_size]
        await conn.executemany(insert_sql, chunk)

    return len(rows)
