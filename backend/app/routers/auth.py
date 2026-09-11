import uuid
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from app.database import get_db
from app.services.auth_service import hash_password, verify_password, create_session, revoke_session, get_full_user
from app.middleware.auth_middleware import get_current_user
from app.models.schemas import LoginRequest, RegisterOrgRequest, UpdateProfileRequest
from app.config import settings
import asyncpg

router = APIRouter(prefix="/auth", tags=["auth"])


def set_session_cookie(response: Response, request: Request, token: str):
    is_https = request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(
        key=settings.SESSION_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=is_https,
        samesite="none" if is_https else "lax",
        max_age=settings.SESSION_TTL_HOURS * 3600,
        path="/",
    )


@router.post("/register-org")
async def register_org(body: RegisterOrgRequest, request: Request, response: Response, conn: asyncpg.Connection = Depends(get_db)):
    email = body.email.strip().lower()
    existing = await conn.fetchrow("SELECT id FROM clarity_app.users WHERE email = $1", email)
    if existing:
        raise HTTPException(status_code=409, detail={"code": "EMAIL_TAKEN", "message": "An account with this email already exists."})

    org_id = str(uuid.uuid4())
    user_id = str(uuid.uuid4())
    membership_id = str(uuid.uuid4())
    password_hash = hash_password(body.password)

    await conn.execute(
        "INSERT INTO clarity_app.organizations (id, name, handle, state) VALUES ($1, $2, $3, 'active')",
        org_id, body.orgName, body.orgHandle
    )
    await conn.execute(
        "INSERT INTO clarity_app.users (id, name, email, password_hash, account_state) VALUES ($1, $2, $3, $4, 'active')",
        user_id, body.adminName, email, password_hash
    )
    await conn.execute(
        """INSERT INTO clarity_app.organization_memberships
           (id, user_id, organization_id, role, status, permission_revision)
           VALUES ($1, $2, $3, 'ORG_ADMIN', 'APPROVED', 1)""",
        membership_id, user_id, org_id
    )

    token = await create_session(conn, user_id)
    set_session_cookie(response, request, token)
    user = await get_full_user(conn, user_id)
    return {"user": user, "token": token}


@router.post("/login")
async def login(body: LoginRequest, request: Request, response: Response, conn: asyncpg.Connection = Depends(get_db)):
    email = body.email.strip().lower()
    row = await conn.fetchrow(
        "SELECT id, name, email, password_hash FROM clarity_app.users WHERE email = $1", email
    )
    if not row or not verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail={"code": "INVALID_CREDENTIALS", "message": "Invalid email or password."})

    token = await create_session(conn, row["id"])
    set_session_cookie(response, request, token)
    user = await get_full_user(conn, row["id"])
    return {"user": user, "token": token}


@router.post("/logout")
async def logout(request: Request, response: Response, conn: asyncpg.Connection = Depends(get_db), user: dict = Depends(get_current_user)):
    token = request.cookies.get(settings.SESSION_COOKIE_NAME)
    if not token:
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if token:
        await revoke_session(conn, token)
    response.delete_cookie(settings.SESSION_COOKIE_NAME, path="/")
    return {"success": True, "message": "Logged out successfully."}


@router.get("/me")
async def get_me(user: dict = Depends(get_current_user)):
    return {"user": user}
