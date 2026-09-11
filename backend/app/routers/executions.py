"""
Execution routes - GET result, retry insight, export CSV
"""
import json
import csv
import io
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from app.database import get_db
from app.middleware.auth_middleware import get_current_user
from app.services.llm_service import LLMService
import asyncpg

router = APIRouter(prefix="/executions", tags=["executions"])


@router.get("/{execution_id}/result")
async def get_execution_result(
    execution_id: str,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    row = await conn.fetchrow(
        """SELECT e.*, r.columns_json, r.rows_json, r.total_rows, r.is_capped,
               i.summary as insight_summary, i.explanation as insight_explanation,
               i.evidence_json, i.chart_recommendation_json,
               p.sql_text
           FROM clarity_app.executions e
           LEFT JOIN clarity_app.result_snapshots r ON e.id = r.execution_id
           LEFT JOIN clarity_app.insights i ON e.id = i.execution_id
           LEFT JOIN clarity_app.previews p ON e.preview_id = p.id
           WHERE e.id = $1 AND e.owner_id = $2""",
        execution_id, user["id"]
    )
    if not row:
        raise HTTPException(
            status_code=404,
            detail={"code": "EXECUTION_NOT_FOUND", "message": "Execution not found."},
        )

    columns = json.loads(row["columns_json"] or "[]")
    rows_data = json.loads(row["rows_json"] or "[]")

    return {
        "id": row["id"],
        "status": row["status"],
        "durationMs": row.get("duration_ms"),
        "errorMessage": row.get("error_message"),
        "sql": row.get("sql_text"),
        "totalRows": row.get("total_rows") or 0,
        "isCapped": bool(row.get("is_capped")),
        "columns": columns,
        "rows": rows_data,
        "insight": {
            "summary": row["insight_summary"],
            "explanation": row["insight_explanation"],
            "evidence": json.loads(row["evidence_json"] or "[]"),
            "chartRecommendation": json.loads(row["chart_recommendation_json"] or "{}"),
        } if row.get("insight_summary") else None,
    }


@router.post("/{execution_id}/insight/retry")
async def retry_insight(
    execution_id: str,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    exec_row = await conn.fetchrow(
        """SELECT e.*, r.columns_json, r.rows_json, r.total_rows, a.question,
               p.sql_text
           FROM clarity_app.executions e
           LEFT JOIN clarity_app.result_snapshots r ON e.id = r.execution_id
           LEFT JOIN clarity_app.previews p ON e.preview_id = p.id
           LEFT JOIN clarity_app.analyses a ON p.analysis_id = a.id
           WHERE e.id = $1 AND e.owner_id = $2""",
        execution_id, user["id"]
    )
    if not exec_row:
        raise HTTPException(
            status_code=404,
            detail={"code": "EXECUTION_NOT_FOUND", "message": "Execution not found."},
        )

    columns = json.loads(exec_row["columns_json"] or "[]")
    rows_data = json.loads(exec_row["rows_json"] or "[]")
    question = exec_row.get("question", "")
    sql = exec_row.get("sql_text", "")

    # Generate insight via LLM
    preview_data = rows_data[:20]
    prompt = f"""You are a data analyst. Given this SQL query result, provide a grounded insight.

Question: {question}
SQL: {sql}
Columns: {json.dumps([c['name'] if isinstance(c, dict) else c for c in columns])}
Sample rows (first 20): {json.dumps(preview_data, default=str)}
Total rows: {exec_row.get('total_rows', 0)}

Respond with JSON only:
{{
  "summary": "One sentence key finding",
  "explanation": "2-3 sentences explaining the data",
  "evidence": [
    {{"claim": "specific finding", "value": "supporting number or fact"}}
  ],
  "chartRecommendation": {{
    "type": "bar|line|pie|scatter|table",
    "xAxis": "column name",
    "yAxis": "column name",
    "title": "Chart title"
  }}
}}"""

    insight = {
        "summary": "Analysis complete.",
        "explanation": f"The query returned {exec_row.get('total_rows', 0)} rows.",
        "evidence": [],
        "chartRecommendation": {"type": "table"},
    }

    try:
        raw = await LLMService.generate(prompt, temperature=0.2)
        if raw:
            # Extract JSON from response
            import re
            json_match = re.search(r'\{.*\}', raw, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group(0))
                insight = parsed
    except Exception:
        pass  # use default insight

    # Upsert insight
    await conn.execute(
        """INSERT INTO clarity_app.insights
           (id, execution_id, summary, explanation, evidence_json, chart_recommendation_json, status)
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'ready')
           ON CONFLICT (execution_id) DO UPDATE
           SET summary=$2, explanation=$3, evidence_json=$4, chart_recommendation_json=$5""",
        execution_id,
        insight.get("summary", ""),
        insight.get("explanation", ""),
        json.dumps(insight.get("evidence", [])),
        json.dumps(insight.get("chartRecommendation", {"type": "table"})),
    )

    return {"success": True, "insight": insight}


@router.get("/{execution_id}/export.csv")
async def export_csv(
    execution_id: str,
    filterCol: str = None,
    filterVal: str = None,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    row = await conn.fetchrow(
        "SELECT r.columns_json, r.rows_json FROM clarity_app.result_snapshots r "
        "JOIN clarity_app.executions e ON r.execution_id = e.id "
        "WHERE r.execution_id = $1 AND e.owner_id = $2",
        execution_id, user["id"]
    )
    if not row:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "message": "Result not found."})

    columns = json.loads(row["columns_json"] or "[]")
    rows_data = json.loads(row["rows_json"] or "[]")

    col_names = [c["name"] if isinstance(c, dict) else c for c in columns]

    # Apply filter if provided
    if filterCol and filterVal:
        rows_data = [r for r in rows_data if str(r.get(filterCol, "")).lower() == filterVal.lower()]

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=col_names, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows_data)
    output.seek(0)

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=result_{execution_id[:8]}.csv"},
    )
