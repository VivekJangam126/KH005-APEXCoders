from fastapi import Request, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from typing import Optional
import asyncpg
from app.database import get_db
from app.services.auth_service import get_user_by_token
from app.config import settings

security = HTTPBearer(auto_error=False)


async def get_current_user(
    request: Request,
    conn: asyncpg.Connection = Depends(get_db),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> dict:
    token = None

    # Try cookie first
    token = request.cookies.get(settings.SESSION_COOKIE_NAME)

    # Fall back to Bearer token
    if not token and credentials:
        token = credentials.credentials

    if not token:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED", "message": "Authentication required."})

    user = await get_user_by_token(conn, token)
    if not user:
        raise HTTPException(status_code=401, detail={"code": "SESSION_EXPIRED", "message": "Session expired. Please sign in again."})

    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("membership", {}) and user["membership"].get("role") != "ORG_ADMIN":
        raise HTTPException(status_code=403, detail={"code": "FORBIDDEN", "message": "Only Organization Administrators can perform this action."})
    return user


def authorize_operation(user: dict, resource: dict, action: str) -> dict:
    """RBAC enforcement - same logic as Node.js authorization.ts"""
    if not user:
        return {"authorized": False, "status": 401, "code": "UNAUTHORIZED"}

    if user.get("account_state") and user["account_state"] != "active":
        return {"authorized": False, "status": 403, "code": "ACCOUNT_DISABLED"}

    if not user.get("organization") or not user.get("membership"):
        return {"authorized": False, "status": 403, "code": "NO_ORGANIZATION_MEMBERSHIP"}

    status = user["membership"]["status"]
    if status == "PENDING":
        return {"authorized": False, "status": 403, "code": "MEMBERSHIP_PENDING"}
    if status == "REJECTED":
        return {"authorized": False, "status": 403, "code": "MEMBERSHIP_REJECTED"}
    if status == "SUSPENDED":
        return {"authorized": False, "status": 403, "code": "MEMBERSHIP_SUSPENDED"}
    if status != "APPROVED":
        return {"authorized": False, "status": 403, "code": "MEMBERSHIP_INACTIVE"}

    # Check org match
    if resource.get("organizationId") and resource["organizationId"] != user["organization"]["id"]:
        return {"authorized": False, "status": 403, "code": "TENANT_FORBIDDEN"}

    role = user["membership"]["role"]
    if role == "ORG_ADMIN":
        return {"authorized": True, "status": 200}

    # MEMBER permissions
    perms = {p["databaseId"]: p for p in (user.get("permissions") or [])}
    db_id = resource.get("databaseId")

    if not db_id or db_id not in perms:
        return {"authorized": False, "status": 403, "code": "PERMISSION_DENIED"}

    grant = perms[db_id]
    action_map = {
        "read": "canRead", "insert": "canInsert", "update": "canUpdate",
        "delete_records": "canDeleteRecords", "import_csv": "canImportCsv", "export": "canExport",
    }
    if action in action_map and not grant.get(action_map[action]):
        return {"authorized": False, "status": 403, "code": "PERMISSION_DENIED"}

    return {"authorized": True, "status": 200}
