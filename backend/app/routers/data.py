"""
Data routes - Table records CRUD, export, append CSV
Maps to frontend api.data.* calls
"""
import uuid
import json
import csv
import io
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Body
from fastapi.responses import StreamingResponse
from app.database import get_db
from app.middleware.auth_middleware import get_current_user
from app.services.csv_service import parse_csv_bytes
import asyncpg

router = APIRouter(tags=["data"])


async def _get_dataset(conn: asyncpg.Connection, dataset_id: str):
    ds = await conn.fetchrow(
        "SELECT * FROM clarity_app.datasets WHERE id = $1 AND lifecycle_state != 'deleted'",
        dataset_id,
    )
    if not ds:
        raise HTTPException(
            status_code=404,
            detail={"code": "DATASET_NOT_FOUND", "message": "Dataset not found."},
        )
    return ds


@router.get("/datasets/{dataset_id}/tables/{table_name}/records")
async def get_table_records(
    dataset_id: str,
    table_name: str,
    # Support both page/pageSize (new) and limit/offset (legacy)
    page: int = Query(default=1, ge=1),
    pageSize: int = Query(default=100, ge=1, le=1000),
    limit: Optional[int] = Query(default=None, ge=1, le=1000),
    offset: Optional[int] = Query(default=None, ge=0),
    search: str = Query(default=""),
    sortCol: str = Query(default=""),
    sortBy: str = Query(default=""),
    sortDir: str = Query(default="asc"),
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    ds = await _get_dataset(conn, dataset_id)
    schema = ds["internal_schema"]

    # Resolve limit/offset — accept either pagination style
    eff_limit = limit if limit is not None else pageSize
    eff_offset = offset if offset is not None else (page - 1) * pageSize
    sort_column = sortCol or sortBy

    # Build safe ORDER BY
    order_clause = ""
    if sort_column:
        direction = "DESC" if sortDir.lower() == "desc" else "ASC"
        order_clause = f' ORDER BY "{sort_column}" {direction} NULLS LAST'

    # Count total
    try:
        count_row = await conn.fetchrow(
            f'SELECT COUNT(*) as cnt FROM "{schema}"."{table_name}"'
        )
        total = int(count_row["cnt"])
    except Exception as e:
        raise HTTPException(status_code=400, detail={"code": "QUERY_FAILED", "message": str(e)})

    # Fetch rows
    try:
        rows = await conn.fetch(
            f'SELECT * FROM "{schema}"."{table_name}"{order_clause} LIMIT $1 OFFSET $2',
            eff_limit, eff_offset,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail={"code": "QUERY_FAILED", "message": str(e)})

    rows_data = [dict(r) for r in rows]
    # Serialize non-JSON-safe types (dates, decimals, etc.)
    for row in rows_data:
        for k, v in row.items():
            if hasattr(v, 'isoformat'):
                row[k] = v.isoformat()

    # Build column metadata from first row keys (or schema)
    columns = []
    if rows_data:
        columns = [{"name": k, "type": "text"} for k in rows_data[0].keys()]

    return {
        "records": rows_data,
        "rows": rows_data,           # alias for legacy callers
        "columns": columns,
        "total": total,
        "totalRows": total,          # alias
        "page": page,
        "pageSize": eff_limit,
        "totalPages": max(1, (total + eff_limit - 1) // eff_limit),
        "pagination": {"total": total, "page": page, "pageSize": eff_limit},
    }


@router.post("/datasets/{dataset_id}/tables/{table_name}/records/preview")
async def preview_mutation(
    dataset_id: str,
    table_name: str,
    body: dict = Body(...),
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    ds = await _get_dataset(conn, dataset_id)
    schema = ds["internal_schema"]
    org_id = ds.get("organization_id") or user.get("organization", {}).get("id") if user.get("organization") else None

    if not org_id:
        raise HTTPException(
            status_code=403,
            detail={"code": "NO_ORGANIZATION", "message": "No organization found."},
        )

    operation = body.get("operation", "insert").upper()
    # Accept both frontend formats: recordData/targetCriteria OR data/where
    data = body.get("data") or body.get("recordData") or {}
    where = body.get("where") or body.get("targetCriteria") or {}

    # Build preview SQL
    preview_id = str(uuid.uuid4())
    digest = str(uuid.uuid4())

    if operation == "INSERT":
        cols = list(data.keys())
        col_list = ", ".join(f'"{c}"' for c in cols)
        val_list = ", ".join(f"${i+1}" for i in range(len(cols)))
        sql = f'INSERT INTO "{schema}"."{table_name}" ({col_list}) VALUES ({val_list})'
        params = list(data.values())
        plan = {"operation": "INSERT", "table": table_name, "data": data}
        affected = 1
    elif operation == "UPDATE":
        set_parts = [f'"{k}" = ${i+1}' for i, k in enumerate(data.keys())]
        where_parts = [f'"{k}" = ${len(data)+i+1}' for i, k in enumerate(where.keys())]
        sql = f'UPDATE "{schema}"."{table_name}" SET {", ".join(set_parts)} WHERE {" AND ".join(where_parts)}'
        params = list(data.values()) + list(where.values())
        plan = {"operation": "UPDATE", "table": table_name, "data": data, "where": where}
        affected = 1
    elif operation == "DELETE":
        where_parts = [f'"{k}" = ${i+1}' for i, k in enumerate(where.keys())]
        sql = f'DELETE FROM "{schema}"."{table_name}" WHERE {" AND ".join(where_parts)}'
        params = list(where.values())
        plan = {"operation": "DELETE", "table": table_name, "where": where}
        affected = 1
    else:
        raise HTTPException(status_code=400, detail={"code": "INVALID_OPERATION", "message": f"Unknown operation: {operation}"})

    # Save operation preview
    try:
        await conn.execute(
            """INSERT INTO clarity_app.operation_previews
               (id, actor_id, organization_id, database_id, table_name, operation,
                sql_text, plan_json, expected_affected_count, digest, expires_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() + INTERVAL '15 minutes')""",
            preview_id, user["id"], org_id, dataset_id, table_name, operation,
            sql, json.dumps(plan), affected, digest
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail={"code": "PREVIEW_FAILED", "message": str(e)})

    return {
        "previewId": preview_id,
        "digest": digest,
        "operation": operation,
        "sql": sql,
        "expectedAffectedCount": affected,
        "plan": plan,
    }


@router.post("/operations/{preview_id}/confirm")
async def confirm_operation(
    preview_id: str,
    body: dict = Body(default={}),
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    preview = await conn.fetchrow(
        "SELECT * FROM clarity_app.operation_previews WHERE id = $1 AND actor_id = $2",
        preview_id, user["id"]
    )
    if not preview:
        raise HTTPException(
            status_code=404,
            detail={"code": "PREVIEW_NOT_FOUND", "message": "Operation preview not found."},
        )
    if preview["is_consumed"]:
        raise HTTPException(
            status_code=409,
            detail={"code": "ALREADY_CONSUMED", "message": "This operation has already been executed."},
        )

    ds = await conn.fetchrow("SELECT * FROM clarity_app.datasets WHERE id = $1", preview["database_id"])
    if not ds:
        raise HTTPException(status_code=404, detail={"code": "DATASET_NOT_FOUND", "message": "Dataset not found."})

    plan = json.loads(preview["plan_json"] or "{}")
    operation = preview["operation"]
    table_name = preview["table_name"]
    schema = ds["internal_schema"]

    try:
        await conn.execute(f'SET search_path TO "{schema}", public')
        result = await conn.execute(preview["sql_text"])
        # Parse affected rows count from result string like "INSERT 0 1" or "UPDATE 1"
        affected = 1
        try:
            parts = result.split()
            affected = int(parts[-1])
        except Exception:
            pass

        await conn.execute(
            "UPDATE clarity_app.operation_previews SET is_consumed=true WHERE id=$1",
            preview_id
        )

        # Log audit event if org exists
        org_id = preview.get("organization_id")
        if org_id:
            await conn.execute(
                """INSERT INTO clarity_app.audit_events
                   (id, organization_id, actor_id, actor_name, actor_email, action, target_type, target_id, target_name, summary, affected_rows)
                   VALUES ($1,$2,$3,$4,$5,$6,'table',$7,$8,$9,$10)""",
                str(uuid.uuid4()), org_id, user["id"], user.get("name", ""), user.get("email", ""),
                f"RECORD_{operation}", ds["id"], table_name,
                f"{operation} on {table_name}", affected
            )

        return {
            "success": True,
            "message": f"{operation} completed successfully.",
            "affectedRows": affected,
            "result": {
                "affectedRows": affected,
                "message": f"{operation} completed successfully.",
            },
        }
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={"code": "OPERATION_FAILED", "message": str(e)},
        )


@router.post("/datasets/{dataset_id}/tables/{table_name}/append-csv")
async def append_csv(
    dataset_id: str,
    table_name: str,
    body: dict = Body(...),
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    ds = await _get_dataset(conn, dataset_id)
    schema = ds["internal_schema"]
    csv_text = body.get("csvText", "")
    if not csv_text:
        raise HTTPException(status_code=400, detail={"code": "NO_DATA", "message": "No CSV data provided."})

    try:
        result = parse_csv_bytes(csv_text.encode("utf-8"), f"{table_name}.csv")
    except Exception as e:
        raise HTTPException(status_code=422, detail={"code": "PARSE_FAILED", "message": str(e)})

    rows = result["allRows"]
    columns = result["columns"]
    if not rows:
        return {"success": True, "rowsAppended": 0}

    col_names = [c["internalName"] for c in columns]
    placeholders = ", ".join(f"${i+1}" for i in range(len(col_names)))
    col_list = ", ".join(f'"{n}"' for n in col_names)
    insert_sql = f'INSERT INTO "{schema}"."{table_name}" ({col_list}) VALUES ({placeholders})'

    records = [tuple(row.get(n) for n in col_names) for row in rows]
    chunk_size = 1000
    for i in range(0, len(records), chunk_size):
        await conn.executemany(insert_sql, records[i:i + chunk_size])

    # Update row count
    await conn.execute(
        """UPDATE clarity_app.dataset_tables
           SET row_count = (SELECT COUNT(*) FROM "{schema}"."{table_name}")
           WHERE dataset_id = $1 AND table_name = $2""".format(schema=schema, table_name=table_name),
        dataset_id, table_name
    )

    return {"success": True, "rowsAppended": len(rows)}


@router.get("/datasets/{dataset_id}/tables/{table_name}/export.csv")
async def export_table_csv(
    dataset_id: str,
    table_name: str,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    ds = await _get_dataset(conn, dataset_id)
    schema = ds["internal_schema"]

    try:
        rows = await conn.fetch(f'SELECT * FROM "{schema}"."{table_name}" LIMIT 100000')
    except Exception as e:
        raise HTTPException(status_code=400, detail={"code": "QUERY_FAILED", "message": str(e)})

    if not rows:
        return StreamingResponse(
            iter(["(no data)\n"]),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={table_name}.csv"},
        )

    col_names = list(rows[0].keys())
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=col_names)
    writer.writeheader()
    for row in rows:
        row_dict = {}
        for k, v in dict(row).items():
            row_dict[k] = v.isoformat() if hasattr(v, 'isoformat') else v
        writer.writerow(row_dict)
    output.seek(0)

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={table_name}.csv"},
    )


@router.post("/datasets/{dataset_id}/tables")
async def create_table(
    dataset_id: str,
    body: dict = Body(...),
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    ds = await _get_dataset(conn, dataset_id)
    schema = ds["internal_schema"]
    table_name = body.get("tableName", "").strip()
    columns = body.get("columns", [])

    if not table_name:
        raise HTTPException(status_code=400, detail={"code": "INVALID_INPUT", "message": "Table name is required."})
    if not columns:
        raise HTTPException(status_code=400, detail={"code": "INVALID_INPUT", "message": "At least one column is required."})

    col_defs = ", ".join(f'"{c["name"]}" {c.get("type", "TEXT")}' for c in columns)
    try:
        await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
        await conn.execute(f'CREATE TABLE "{schema}"."{table_name}" ({col_defs})')
        await conn.execute(
            "INSERT INTO clarity_app.dataset_tables (id, dataset_id, table_name, row_count, row_count_type) VALUES ($1,$2,$3,0,'exact')",
            str(uuid.uuid4()), dataset_id, table_name
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail={"code": "CREATE_FAILED", "message": str(e)})

    return {"success": True, "tableName": table_name}


@router.post("/datasets/{dataset_id}/tables/{table_name}/drop")
async def drop_table(
    dataset_id: str,
    table_name: str,
    body: dict = Body(default={}),
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    # Admin only
    if not user.get("membership") or user["membership"].get("role") != "ORG_ADMIN":
        raise HTTPException(
            status_code=403,
            detail={"code": "FORBIDDEN", "message": "Only admins can drop tables."},
        )

    ds = await _get_dataset(conn, dataset_id)
    schema = ds["internal_schema"]

    try:
        await conn.execute(f'DROP TABLE IF EXISTS "{schema}"."{table_name}" CASCADE')
        await conn.execute(
            "DELETE FROM clarity_app.dataset_tables WHERE dataset_id=$1 AND table_name=$2",
            dataset_id, table_name
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail={"code": "DROP_FAILED", "message": str(e)})

    return {"success": True, "message": f"Table '{table_name}' dropped."}
