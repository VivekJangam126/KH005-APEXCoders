from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.database import get_pool, close_pool, run_migrations
from app.services.llm_service import LLMService
from app.routers import auth, profile, uploads, datasets, queries, health, history
from app.routers import executions, data, admin


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────────
    print("Starting ClaritySQL FastAPI backend...")
    try:
        pool = await get_pool()
        print("[DB] PostgreSQL connection pool ready.")
        await run_migrations(pool)
    except Exception as e:
        print(f"[DB] Failed to connect or migrate: {e}")
        print("[DB] WARNING: Application will start but database operations will fail.")

    try:
        await LLMService.initialize()
    except Exception as e:
        print(f"[LLM] Initialization warning: {e}")

    yield

    # ── Shutdown ─────────────────────────────────────────────────────────────
    await close_pool()
    print("Server shutting down.")


app = FastAPI(
    title="ClaritySQL API",
    version="2.0.0",
    description="AI-powered natural language to SQL platform",
    lifespan=lifespan,
)

# ── CORS ─────────────────────────────────────────────────────────────────────
origins = [
    settings.APP_URL,
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Global error handler ──────────────────────────────────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "INTERNAL_ERROR",
                "message": str(exc),
                "retryable": False,
            }
        },
    )


# ── Mount all routers under /api ─────────────────────────────────────────────
app.include_router(health.router,      prefix="/api")
app.include_router(auth.router,        prefix="/api")
app.include_router(profile.router,     prefix="/api")
app.include_router(uploads.router,     prefix="/api")
app.include_router(datasets.router,    prefix="/api")
app.include_router(queries.router,     prefix="/api")
app.include_router(history.router,     prefix="/api")
app.include_router(executions.router,  prefix="/api")
app.include_router(data.router,        prefix="/api")
app.include_router(admin.router,       prefix="/api")
app.include_router(admin.invitations_router, prefix="/api")
