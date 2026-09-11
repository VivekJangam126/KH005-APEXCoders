import uuid
import json
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from app.database import get_db
from app.middleware.auth_middleware import get_current_user
from app.services.csv_service import parse_csv_bytes, sanitize_identifier
from app.config import settings
import asyncpg

router = APIRouter(prefix="/uploads", tags=["uploads"])


@router.post("")
async def upload_file(
    file: UploadFile = File(...),
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    data = await file.read()
    if len(data) > settings.MAX_CSV_BYTES:
        raise HTTPException(
            status_code=413,
            detail={"code": "FILE_TOO_LARGE", "message": f"File exceeds {settings.MAX_CSV_BYTES // 1048576}MB limit."},
        )

    filename = file.filename or "data.csv"
    job_id = str(uuid.uuid4())
    # organization_id is optional – users without an org can still upload
    org_id = None
    if user.get("organization") and user["organization"].get("id"):
        org_id = user["organization"]["id"]
    user_id = user["id"]

    try:
        result = parse_csv_bytes(data, filename)
    except Exception as e:
        raise HTTPException(status_code=422, detail={"code": "PARSE_FAILED", "message": str(e)})

    table_name = sanitize_identifier(filename.rsplit(".", 1)[0])
    candidate_tables = [
        {
            "id": table_name,
            "name": table_name,
            "columns": result["columns"],
            "rows": result["previewRows"],
            "rowCount": result["totalRows"],
            "issues": result["issues"],
        }
    ]

    await conn.execute(
        """INSERT INTO clarity_app.ingestion_jobs (
              id, organization_id, created_by, source_file_name, source_file_type,
              source_file_size, source_hash, format, parser_version, extraction_status,
              plan_hash, expires_at, raw_file_path, lifecycle_status,
              source_coverage, candidate_tables, selected_tables, column_mappings,
              inferred_types, total_rows_per_table, issues, transformations,
              source_references, proposed_relationships
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                      NOW() + INTERVAL '24 hours',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)""",
        job_id, org_id, user_id, filename, file.content_type or "text/csv",
        len(data), result["checksum"], ".csv", "1.0", "READY_FOR_REVIEW",
        result["checksum"][:16], "", "staged",
        "{}", json.dumps(candidate_tables), json.dumps([table_name]), "{}",
        "{}", json.dumps({table_name: result["totalRows"]}), "[]", "[]", "{}", "[]",
    )

    # Bulk insert staged rows in chunks of 500
    all_rows = result["allRows"]
    if all_rows:
        chunk_size = 500
        for start in range(0, len(all_rows), chunk_size):
            chunk = all_rows[start : start + chunk_size]
            records = [
                (str(uuid.uuid4()), job_id, table_name, start + i, json.dumps(row))
                for i, row in enumerate(chunk)
            ]
            await conn.executemany(
                "INSERT INTO clarity_app.staged_rows (id, job_id, table_name, row_index, data_json) VALUES ($1,$2,$3,$4,$5)",
                records,
            )

    return {
        "uploadId": job_id,
        "originalFilename": filename,
        "sizeBytes": len(data),
        "checksum": result["checksum"],
        "totalRows": result["totalRows"],
        "totalColumns": result["totalColumns"],
        "columns": result["columns"],
        "previewRows": result["previewRows"],
        "issues": result["issues"],
        "extractionStatus": "READY_FOR_REVIEW",
        "candidateTables": candidate_tables,
    }


@router.get("/{upload_id}")
async def get_upload(
    upload_id: str,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    row = await conn.fetchrow(
        "SELECT * FROM clarity_app.ingestion_jobs WHERE id = $1 AND created_by = $2",
        upload_id, user["id"],
    )
    if not row:
        raise HTTPException(
            status_code=404,
            detail={"code": "UPLOAD_NOT_FOUND", "message": "Upload not found."},
        )

    candidate_tables = json.loads(row["candidate_tables"] or "[]")
    legacy_cols = candidate_tables[0]["columns"] if candidate_tables else []
    legacy_preview = candidate_tables[0]["rows"][:100] if candidate_tables else []

    return {
        "id": row["id"],
        "originalFilename": row["source_file_name"],
        "sizeBytes": int(row["source_file_size"]),
        "checksum": row["source_hash"],
        "status": row["extraction_status"],
        "stage": row["lifecycle_status"],
        "totalRows": candidate_tables[0]["rowCount"] if candidate_tables else 0,
        "totalColumns": len(legacy_cols),
        "columns": legacy_cols,
        "previewRows": legacy_preview,
        "issues": json.loads(row["issues"] or "[]"),
        "extractionStatus": row["extraction_status"],
        "candidateTables": candidate_tables,
    }


@router.delete("/{upload_id}")
async def delete_upload(
    upload_id: str,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    await conn.execute(
        "DELETE FROM clarity_app.ingestion_jobs WHERE id = $1 AND created_by = $2",
        upload_id, user["id"],
    )
    return {"success": True, "message": "Upload draft discarded."}
