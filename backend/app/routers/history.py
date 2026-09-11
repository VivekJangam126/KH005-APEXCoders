import json
from fastapi import APIRouter, Depends, Query
from app.database import get_db
from app.middleware.auth_middleware import get_current_user
import asyncpg

router = APIRouter(tags=["history"])


@router.get("/history")
async def get_history(
    search: str = Query(default=""),
    status: str = Query(default=""),
    limit: int = Query(default=50),
    offset: int = Query(default=0),
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    conditions = ["a.owner_id = $1"]
    params = [user["id"]]
    idx = 2

    if search:
        conditions.append(f"a.question ILIKE ${idx}")
        params.append(f"%{search}%")
        idx += 1
    if status:
        conditions.append(f"a.status = ${idx}")
        params.append(status)
        idx += 1

    where = " AND ".join(conditions)
    rows = await conn.fetch(
        f"""SELECT a.id, a.question, a.status, a.summary, a.created_at,
               e.id as execution_id, e.status as execution_status, e.duration_ms,
               r.total_rows, p.sql_text
            FROM clarity_app.analyses a
            LEFT JOIN clarity_app.previews p ON a.id = p.analysis_id
            LEFT JOIN clarity_app.executions e ON p.id = e.preview_id
            LEFT JOIN clarity_app.result_snapshots r ON e.id = r.execution_id
            WHERE {where}
            ORDER BY a.created_at DESC
            LIMIT ${idx} OFFSET ${idx+1}""",
        *params, limit, offset
    )

    history = [
        {
            "id": r["id"],
            "question": r["question"],
            "status": r["status"],
            "summary": r.get("summary"),
            "createdAt": str(r["created_at"]),
            "executionId": r.get("execution_id"),
            "executionStatus": r.get("execution_status"),
            "durationMs": r.get("duration_ms"),
            "totalRows": r.get("total_rows") or 0,
            "sql": r.get("sql_text"),
        }
        for r in rows
    ]
    return {"history": history}


@router.get("/notifications")
async def get_notifications(conn: asyncpg.Connection = Depends(get_db), user: dict = Depends(get_current_user)):
    rows = await conn.fetch(
        "SELECT * FROM clarity_app.notifications WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 50",
        user["id"]
    )
    notifications = [
        {
            "id": r["id"],
            "title": r["title"],
            "message": r["message"],
            "eventType": r["event_type"],
            "relatedEntityType": r.get("related_entity_type"),
            "relatedEntityId": r.get("related_entity_id"),
            "isRead": r["is_read"],
            "createdAt": str(r["created_at"]),
        }
        for r in rows
    ]
    unread = sum(1 for n in notifications if not n["isRead"])
    return {"notifications": notifications, "unreadCount": unread}


@router.patch("/notifications/{notif_id}")
async def mark_read(notif_id: str, conn: asyncpg.Connection = Depends(get_db), user: dict = Depends(get_current_user)):
    await conn.execute(
        "UPDATE clarity_app.notifications SET is_read=true WHERE id=$1 AND owner_id=$2",
        notif_id, user["id"]
    )
    return {"success": True}


@router.post("/notifications/read-all")
async def mark_all_read(conn: asyncpg.Connection = Depends(get_db), user: dict = Depends(get_current_user)):
    await conn.execute("UPDATE clarity_app.notifications SET is_read=true WHERE owner_id=$1", user["id"])
    return {"success": True}
