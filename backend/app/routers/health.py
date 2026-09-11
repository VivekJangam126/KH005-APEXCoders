from fastapi import APIRouter, Depends
from app.database import get_db
from app.services.llm_service import LLMService
from app.config import settings
from datetime import datetime, timezone
import asyncpg

router = APIRouter(tags=["health"])


@router.get("/health")
async def health_check(conn: asyncpg.Connection = Depends(get_db)):
    db_ok = False
    db_engine = "PostgreSQL"
    try:
        await conn.fetchval("SELECT 1")
        db_ok = True
    except Exception:
        pass

    return {
        "status": "healthy" if db_ok else "degraded",
        "database": {
            "status": "connected" if db_ok else "disconnected",
            "engine": db_engine,
            "ready": db_ok,
        },
        "aiModel": settings.GEMINI_MODEL,
        "llmProvider": LLMService._provider or "none",
        "hasApiKey": bool(settings.GEMINI_API_KEY and settings.GEMINI_API_KEY != "sk-placeholder"),
        "version": "2.0.0",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
