"""
Queries / Analyses routes
POST /api/analyses           — create analysis
POST /api/analyses/:id/prepare  — generate SQL
GET  /api/analyses/:id          — get analysis
POST /api/previews/:id/confirm  — confirm preview & execute SQL
"""
import uuid
import json
import time
from fastapi import APIRouter, Depends, HTTPException, Body
from app.database import get_db
from app.middleware.auth_middleware import get_current_user
from app.models.schemas import AnalyzeRequest
from app.services.llm_service import generate_sql, LLMService, format_schema_for_prompt
from app.services.schema_service import extract_schema_metadata
import asyncpg

router = APIRouter(tags=["queries"])


@router.post("/analyses")
async def create_analysis(
    body: AnalyzeRequest,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    ds = await conn.fetchrow("SELECT * FROM clarity_app.datasets WHERE id = $1", body.datasetId)
    if not ds:
        raise HTTPException(
            status_code=404,
            detail={"code": "DATASET_NOT_FOUND", "message": "Dataset not found."},
        )

    analysis_id = str(uuid.uuid4())
    await conn.execute(
        """INSERT INTO clarity_app.analyses
           (id, owner_id, dataset_id, question, status, intent_json, summary)
           VALUES ($1, $2, $3, $4, 'draft', '{}', '')""",
        analysis_id, user["id"], body.datasetId, body.question,
    )
    return {"analysisId": analysis_id, "status": "draft"}


@router.post("/analyses/{analysis_id}/prepare")
async def prepare_analysis(
    analysis_id: str,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    analysis = await conn.fetchrow(
        "SELECT * FROM clarity_app.analyses WHERE id = $1 AND owner_id = $2",
        analysis_id, user["id"],
    )
    if not analysis:
        raise HTTPException(
            status_code=404,
            detail={"code": "ANALYSIS_NOT_FOUND", "message": "Analysis not found."},
        )

    ds = await conn.fetchrow(
        "SELECT * FROM clarity_app.datasets WHERE id = $1", analysis["dataset_id"]
    )
    if not ds:
        raise HTTPException(
            status_code=404,
            detail={"code": "DATASET_NOT_FOUND", "message": "Dataset not found."},
        )

    await conn.execute(
        "UPDATE clarity_app.analyses SET status='preparing', updated_at=NOW() WHERE id=$1",
        analysis_id,
    )

    schema_meta = await extract_schema_metadata(conn, ds["id"], ds["internal_schema"])
    tables = schema_meta["tables"]
    fingerprint = schema_meta["fingerprint"]
    question = analysis["question"]

    if not tables:
        await conn.execute("UPDATE clarity_app.analyses SET status='failed' WHERE id=$1", analysis_id)
        raise HTTPException(
            status_code=400,
            detail={"code": "EMPTY_DATASET", "message": "The dataset contains no tables."},
        )

    # Generate SQL with up to 3 correction attempts
    sql = ""
    last_errors: list = []
    attempts = []
    max_attempts = 3

    for attempt_num in range(1, max_attempts + 1):
        sql = await generate_sql(
            question, tables,
            previous_sql=sql if attempt_num > 1 else None,
            errors=last_errors if attempt_num > 1 else None,
        )
        is_valid = bool(sql and sql.upper().strip().startswith("SELECT"))
        report = {
            "isValid": is_valid,
            "errors": [] if is_valid else ["Query must start with SELECT"],
        }
        attempts.append({
            "attemptNumber": attempt_num,
            "sql": sql,
            "report": report,
            "correctionReason": "Previous attempt failed validation" if attempt_num > 1 else None,
        })
        if is_valid:
            break
        last_errors = report["errors"]

    # Persist attempts
    for att in attempts:
        await conn.execute(
            """INSERT INTO clarity_app.sql_attempts
               (id, analysis_id, attempt_number, sql_text, validation_report_json, correction_reason)
               VALUES ($1,$2,$3,$4,$5,$6)""",
            str(uuid.uuid4()), analysis_id, att["attemptNumber"],
            att["sql"], json.dumps(att["report"]), att.get("correctionReason"),
        )

    final_report = attempts[-1]["report"]
    summary = f'Analyze: "{question}"'

    # Create preview record
    preview_id = str(uuid.uuid4())
    digest = str(uuid.uuid4())
    await conn.execute(
        """INSERT INTO clarity_app.previews
           (id, analysis_id, owner_id, dataset_id, schema_fingerprint,
            sql_text, params_json, result_limit, validation_report_json,
            digest, is_consumed, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,'[]',1000,$7,$8,false, NOW() + INTERVAL '15 minutes')""",
        preview_id, analysis_id, user["id"], ds["id"],
        fingerprint, sql, json.dumps(final_report), digest,
    )

    await conn.execute(
        "UPDATE clarity_app.analyses SET status='ready_for_review', summary=$2, updated_at=NOW() WHERE id=$1",
        analysis_id, summary,
    )

    return {
        "analysisId": analysis_id,
        "status": "ready_for_review",
        "message": "Ready for your review. This query has not run yet.",
        "interpretation": {
            "status": "ready",
            "summary": summary,
        },
        "preview": {
            "id": preview_id,
            "sql": sql,
            "params": [],
            "digest": digest,
            "validationReport": final_report,
            "isConsumed": False,
            "attemptsCount": len(attempts),
        },
        "attempts": attempts,
    }


@router.get("/analyses/{analysis_id}")
async def get_analysis(
    analysis_id: str,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    row = await conn.fetchrow(
        """SELECT a.*,
               p.id as preview_id, p.sql_text, p.params_json, p.digest,
               p.validation_report_json, p.is_consumed,
               e.id as execution_id, e.status as execution_status, e.duration_ms,
               r.columns_json, r.rows_json, r.total_rows, r.is_capped,
               i.summary as insight_summary, i.explanation as insight_explanation,
               i.evidence_json, i.chart_recommendation_json
           FROM clarity_app.analyses a
           LEFT JOIN clarity_app.previews p ON a.id = p.analysis_id
           LEFT JOIN clarity_app.executions e ON p.id = e.preview_id
           LEFT JOIN clarity_app.result_snapshots r ON e.id = r.execution_id
           LEFT JOIN clarity_app.insights i ON e.id = i.execution_id
           WHERE a.id = $1 AND a.owner_id = $2
           ORDER BY p.created_at DESC NULLS LAST
           LIMIT 1""",
        analysis_id, user["id"],
    )
    if not row:
        raise HTTPException(
            status_code=404,
            detail={"code": "ANALYSIS_NOT_FOUND", "message": "Analysis not found."},
        )

    attempts = await conn.fetch(
        """SELECT attempt_number, sql_text, validation_report_json, correction_reason
           FROM clarity_app.sql_attempts WHERE analysis_id = $1 ORDER BY attempt_number ASC""",
        analysis_id,
    )

    return {
        "id": row["id"],
        "question": row["question"],
        "status": row["status"],
        "summary": row.get("summary"),
        "createdAt": str(row["created_at"]),
        "attempts": [
            {
                "attemptNumber": a["attempt_number"],
                "sql": a["sql_text"],
                "report": json.loads(a["validation_report_json"] or "{}"),
                "correctionReason": a.get("correction_reason"),
            }
            for a in attempts
        ],
        "preview": {
            "id": row["preview_id"],
            "sql": row["sql_text"],
            "params": json.loads(row["params_json"] or "[]"),
            "digest": row["digest"],
            "validationReport": json.loads(row["validation_report_json"] or "{}"),
            "isConsumed": bool(row["is_consumed"]),
        } if row.get("preview_id") else None,
        "execution": {
            "id": row["execution_id"],
            "status": row["execution_status"],
            "durationMs": row.get("duration_ms"),
            "totalRows": row.get("total_rows") or 0,
            "isCapped": bool(row.get("is_capped")),
            "columns": json.loads(row["columns_json"] or "[]"),
            "rows": json.loads(row["rows_json"] or "[]"),
            "insight": {
                "summary": row["insight_summary"],
                "explanation": row["insight_explanation"],
                "evidence": json.loads(row["evidence_json"] or "[]"),
                "chartRecommendation": json.loads(row["chart_recommendation_json"] or "{}"),
            } if row.get("insight_summary") else None,
        } if row.get("execution_id") else None,
    }


@router.post("/previews/{preview_id}/confirm")
async def confirm_preview(
    preview_id: str,
    body: dict = Body(default={}),
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    preview = await conn.fetchrow(
        "SELECT * FROM clarity_app.previews WHERE id = $1 AND owner_id = $2",
        preview_id, user["id"],
    )
    if not preview:
        raise HTTPException(
            status_code=404,
            detail={"code": "PREVIEW_NOT_FOUND", "message": "Preview not found."},
        )

    # If already consumed, return existing execution result
    if preview["is_consumed"]:
        exec_row = await conn.fetchrow(
            """SELECT e.*, r.columns_json, r.rows_json, r.total_rows, r.is_capped
               FROM clarity_app.executions e
               LEFT JOIN clarity_app.result_snapshots r ON e.id = r.execution_id
               WHERE e.preview_id = $1 LIMIT 1""",
            preview_id,
        )
        if exec_row:
            return {
                "success": True,
                "result": {
                    "id": exec_row["id"],
                    "status": exec_row["status"],
                    "durationMs": exec_row.get("duration_ms"),
                    "totalRows": exec_row.get("total_rows") or 0,
                    "isCapped": bool(exec_row.get("is_capped")),
                    "columns": json.loads(exec_row["columns_json"] or "[]"),
                    "rows": json.loads(exec_row["rows_json"] or "[]"),
                },
            }

    ds = await conn.fetchrow(
        "SELECT * FROM clarity_app.datasets WHERE id = $1", preview["dataset_id"]
    )
    if not ds:
        raise HTTPException(
            status_code=404,
            detail={"code": "DATASET_NOT_FOUND", "message": "Dataset not found."},
        )

    sql = preview["sql_text"]
    execution_id = str(uuid.uuid4())
    start = time.time()

    try:
        await conn.execute(f'SET search_path TO "{ds["internal_schema"]}", public')
        db_rows = await conn.fetch(sql)
        duration_ms = int((time.time() - start) * 1000)

        if db_rows:
            columns = [{"name": k, "type": "text"} for k in db_rows[0].keys()]
            rows_data = []
            for r in db_rows:
                row_dict = {}
                for k, v in dict(r).items():
                    row_dict[k] = v.isoformat() if hasattr(v, "isoformat") else v
                rows_data.append(row_dict)
        else:
            columns = []
            rows_data = []

        total_rows = len(rows_data)
        is_capped = total_rows >= 1000
        rows_data = rows_data[:1000]

        idempotency_key = str(uuid.uuid4())
        await conn.execute(
            """INSERT INTO clarity_app.executions
               (id, preview_id, analysis_id, owner_id, dataset_id, idempotency_key, status, duration_ms, completed_at)
               VALUES ($1,$2,$3,$4,$5,$6,'completed',$7,NOW())""",
            execution_id, preview_id, preview.get("analysis_id"),
            user["id"], ds["id"], idempotency_key, duration_ms,
        )
        await conn.execute(
            """INSERT INTO clarity_app.result_snapshots
               (id, execution_id, columns_json, rows_json, total_rows, is_capped, size_bytes)
               VALUES ($1,$2,$3,$4,$5,$6,$7)""",
            str(uuid.uuid4()), execution_id,
            json.dumps(columns),
            json.dumps(rows_data, default=str),
            total_rows, is_capped,
            len(json.dumps(rows_data, default=str)),
        )
        await conn.execute(
            "UPDATE clarity_app.previews SET is_consumed=true WHERE id=$1", preview_id
        )
        await conn.execute(
            "UPDATE clarity_app.analyses SET status='completed', updated_at=NOW() WHERE id=$1",
            preview.get("analysis_id"),
        )

        return {
            "success": True,
            "result": {
                "id": execution_id,
                "status": "completed",
                "durationMs": duration_ms,
                "columns": columns,
                "rows": rows_data,
                "totalRows": total_rows,
                "isCapped": is_capped,
            },
        }

    except Exception as e:
        duration_ms = int((time.time() - start) * 1000)
        idempotency_key = str(uuid.uuid4())
        await conn.execute(
            """INSERT INTO clarity_app.executions
               (id, preview_id, owner_id, idempotency_key, status, duration_ms, error_message, completed_at)
               VALUES ($1,$2,$3,$4,'failed',$5,$6,NOW())""",
            execution_id, preview_id, user["id"], idempotency_key, duration_ms, str(e),
        )
        raise HTTPException(
            status_code=400,
            detail={"code": "EXECUTION_FAILED", "message": str(e)},
        )
