"""
Admin routes - Organizations, Users, Memberships, Invitations, Audit logs
"""
import uuid
import json
import secrets
import hashlib
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Body
from app.database import get_db
from app.middleware.auth_middleware import get_current_user, require_admin
from app.services.auth_service import hash_password
import asyncpg

router = APIRouter(prefix="/admin", tags=["admin"])


# ─── Organizations ────────────────────────────────────────────────────────────

@router.get("/organizations")
async def list_organizations(
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(require_admin),
):
    rows = await conn.fetch("SELECT * FROM clarity_app.organizations ORDER BY created_at DESC")
    orgs = [
        {
            "id": r["id"], "name": r["name"], "handle": r["handle"],
            "state": r["state"], "createdAt": str(r["created_at"]),
        }
        for r in rows
    ]
    return {"organizations": orgs}


@router.post("/organizations")
async def create_organization(
    body: dict = Body(...),
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(require_admin),
):
    org_id = str(uuid.uuid4())
    await conn.execute(
        "INSERT INTO clarity_app.organizations (id, name, handle, state) VALUES ($1,$2,$3,'active')",
        org_id, body.get("name", "").strip(), body.get("handle", "").strip().lower()
    )
    return {"success": True, "organizationId": org_id}


@router.patch("/organizations/{org_id}")
async def update_organization(
    org_id: str,
    body: dict = Body(...),
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(require_admin),
):
    updates = []
    params = []
    idx = 1
    if "name" in body:
        updates.append(f"name = ${idx}")
        params.append(body["name"].strip())
        idx += 1
    if "state" in body:
        updates.append(f"state = ${idx}")
        params.append(body["state"])
        idx += 1
    if not updates:
        raise HTTPException(status_code=400, detail={"code": "NO_UPDATES", "message": "Nothing to update."})
    params.append(org_id)
    await conn.execute(
        f"UPDATE clarity_app.organizations SET {', '.join(updates)}, updated_at=NOW() WHERE id = ${idx}",
        *params
    )
    return {"success": True}


@router.get("/organizations/{org_id}")
async def get_organization(
    org_id: str,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    org = await conn.fetchrow("SELECT * FROM clarity_app.organizations WHERE id = $1", org_id)
    if not org:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "message": "Organization not found."})
    members = await conn.fetch(
        """SELECT m.*, u.name, u.email, u.account_state
           FROM clarity_app.organization_memberships m
           JOIN clarity_app.users u ON m.user_id = u.id
           WHERE m.organization_id = $1 ORDER BY m.requested_at DESC""",
        org_id
    )
    return {
        "organization": {
            "id": org["id"],
            "name": org["name"],
            "handle": org["handle"],
            "state": org["state"],
            "createdAt": str(org["created_at"]),
        },
        # Also expose at top-level for compatibility
        "id": org["id"],
        "name": org["name"],
        "handle": org["handle"],
        "state": org["state"],
        "createdAt": str(org["created_at"]),
        "members": [
            {
                "id": m["id"],
                "membershipId": m["id"],
                "userId": m["user_id"],
                "userName": m["name"],
                "name": m["name"],
                "userEmail": m["email"],
                "email": m["email"],
                "role": m["role"],
                "status": m["status"],
                "accountState": m["account_state"],
                "requestedAt": str(m["requested_at"]),
                "approvedAt": str(m["approved_at"]) if m.get("approved_at") else None,
            }
            for m in members
        ],
    }


# ─── Users ────────────────────────────────────────────────────────────────────

@router.get("/users")
async def list_users(
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(require_admin),
):
    org_id = user.get("organization", {}).get("id") if user.get("organization") else None
    if org_id:
        rows = await conn.fetch(
            """SELECT u.*, m.role, m.status, m.id as membership_id
               FROM clarity_app.users u
               LEFT JOIN clarity_app.organization_memberships m ON m.user_id = u.id AND m.organization_id = $1
               ORDER BY u.created_at DESC""",
            org_id
        )
    else:
        rows = await conn.fetch("SELECT * FROM clarity_app.users ORDER BY created_at DESC")

    users = [
        {
            "id": r["id"], "name": r["name"], "email": r["email"],
            "accountState": r.get("account_state", "active"),
            "createdAt": str(r["created_at"]),
            "role": r.get("role"), "status": r.get("status"),
            "membershipId": r.get("membership_id"),
        }
        for r in rows
    ]
    return {"users": users}


@router.post("/users")
async def create_user(
    body: dict = Body(...),
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(require_admin),
):
    email = body.get("email", "").strip().lower()
    name = body.get("name", "").strip()
    password = body.get("password", secrets.token_hex(8))
    role = body.get("role", "MEMBER")
    org_id = user.get("organization", {}).get("id") if user.get("organization") else None

    existing = await conn.fetchrow("SELECT id FROM clarity_app.users WHERE email = $1", email)
    if existing:
        raise HTTPException(status_code=409, detail={"code": "EMAIL_TAKEN", "message": "Email already in use."})

    user_id = str(uuid.uuid4())
    password_hash = hash_password(password)
    await conn.execute(
        "INSERT INTO clarity_app.users (id, name, email, password_hash, account_state) VALUES ($1,$2,$3,$4,'active')",
        user_id, name, email, password_hash
    )

    if org_id:
        membership_id = str(uuid.uuid4())
        await conn.execute(
            """INSERT INTO clarity_app.organization_memberships
               (id, user_id, organization_id, role, status, permission_revision)
               VALUES ($1,$2,$3,$4,'APPROVED',1)""",
            membership_id, user_id, org_id, role
        )

    return {"success": True, "userId": user_id, "temporaryPassword": password}


@router.patch("/users/{user_id}/permissions")
async def update_user_permissions(
    user_id: str,
    body: dict = Body(...),
    conn: asyncpg.Connection = Depends(get_db),
    admin_user: dict = Depends(require_admin),
):
    await conn.execute(
        "UPDATE clarity_app.organization_memberships SET role=$1, updated_at=NOW() WHERE user_id=$2",
        body.get("permissionLevel", "MEMBER"), user_id
    )
    return {"success": True}


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    conn: asyncpg.Connection = Depends(get_db),
    admin_user: dict = Depends(require_admin),
):
    if user_id == admin_user["id"]:
        raise HTTPException(status_code=400, detail={"code": "CANNOT_DELETE_SELF", "message": "You cannot delete your own account."})
    await conn.execute("DELETE FROM clarity_app.users WHERE id = $1", user_id)
    return {"success": True}


# ─── Memberships ─────────────────────────────────────────────────────────────

@router.post("/memberships/{membership_id}/status")
async def update_membership_status(
    membership_id: str,
    body: dict = Body(...),
    conn: asyncpg.Connection = Depends(get_db),
    admin_user: dict = Depends(require_admin),
):
    status = body.get("status")
    rejection_reason = body.get("rejectionReason")

    if status == "APPROVED":
        await conn.execute(
            "UPDATE clarity_app.organization_memberships SET status='APPROVED', approved_at=NOW(), updated_at=NOW() WHERE id=$1",
            membership_id
        )
    elif status in ("REJECTED", "SUSPENDED"):
        await conn.execute(
            "UPDATE clarity_app.organization_memberships SET status=$1, rejection_reason=$2, updated_at=NOW() WHERE id=$3",
            status, rejection_reason, membership_id
        )
    else:
        raise HTTPException(status_code=400, detail={"code": "INVALID_STATUS", "message": f"Invalid status: {status}"})

    return {"success": True}


@router.put("/memberships/{membership_id}/permissions/{database_id}")
async def update_member_permissions(
    membership_id: str,
    database_id: str,
    body: dict = Body(...),
    conn: asyncpg.Connection = Depends(get_db),
    admin_user: dict = Depends(require_admin),
):
    perm_id = str(uuid.uuid4())
    await conn.execute(
        """INSERT INTO clarity_app.database_permissions
           (id, membership_id, database_id, can_read, can_insert, can_update,
            can_delete_records, can_import_csv, can_export, granted_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (membership_id, database_id) DO UPDATE
           SET can_read=$4, can_insert=$5, can_update=$6, can_delete_records=$7,
               can_import_csv=$8, can_export=$9, updated_at=NOW()""",
        perm_id, membership_id, database_id,
        bool(body.get("canRead", True)),
        bool(body.get("canInsert", False)),
        bool(body.get("canUpdate", False)),
        bool(body.get("canDeleteRecords", False)),
        bool(body.get("canImportCsv", False)),
        bool(body.get("canExport", True)),
        admin_user["id"]
    )
    return {"success": True}


# ─── Audit Logs ───────────────────────────────────────────────────────────────

@router.get("/audit-logs/{org_id}")
async def get_audit_logs(
    org_id: str,
    limit: int = 100,
    offset: int = 0,
    conn: asyncpg.Connection = Depends(get_db),
    admin_user: dict = Depends(require_admin),
):
    rows = await conn.fetch(
        """SELECT * FROM clarity_app.audit_events
           WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3""",
        org_id, limit, offset
    )
    logs = [
        {
            "id": r["id"],
            "actorId": r.get("actor_id"),
            "actorName": r.get("actor_name"),
            "actorEmail": r.get("actor_email"),
            "action": r["action"],
            "targetType": r["target_type"],
            "targetId": r.get("target_id"),
            "targetName": r.get("target_name"),
            "summary": r["summary"],
            "outcome": r["outcome"],
            "affectedRows": r.get("affected_rows") or 0,
            "createdAt": str(r["created_at"]),
        }
        for r in rows
    ]
    return {"logs": logs, "auditLogs": logs, "total": len(logs)}


# ─── Invitations ──────────────────────────────────────────────────────────────

invitations_router = APIRouter(prefix="/invitations", tags=["invitations"])


@invitations_router.get("/{token}")
async def get_invitation(
    token: str,
    conn: asyncpg.Connection = Depends(get_db),
):
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    inv = await conn.fetchrow(
        """SELECT i.*, o.name as org_name, o.handle as org_handle
           FROM clarity_app.invitations i
           JOIN clarity_app.organizations o ON i.organization_id = o.id
           WHERE i.token_hash = $1 AND i.status = 'pending' AND i.expires_at > NOW()""",
        token_hash
    )
    if not inv:
        raise HTTPException(
            status_code=404,
            detail={"code": "INVITATION_NOT_FOUND", "message": "Invitation not found or expired."},
        )
    return {
        "id": inv["id"],
        "name": inv["name"],
        "email": inv["email"],
        "organization": {"id": inv["organization_id"], "name": inv["org_name"], "handle": inv["org_handle"]},
        "permissions": json.loads(inv["permissions_json"] or "[]"),
    }


@invitations_router.post("/{token}/accept")
async def accept_invitation(
    token: str,
    body: dict = Body(...),
    conn: asyncpg.Connection = Depends(get_db),
):
    from app.services.auth_service import create_session
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    inv = await conn.fetchrow(
        "SELECT * FROM clarity_app.invitations WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()",
        token_hash
    )
    if not inv:
        raise HTTPException(
            status_code=404,
            detail={"code": "INVITATION_NOT_FOUND", "message": "Invitation not found or expired."},
        )

    name = body.get("name", inv["name"]).strip()
    password = body.get("password", "").strip()
    if not password:
        raise HTTPException(status_code=400, detail={"code": "INVALID_INPUT", "message": "Password is required."})

    # Create or get user
    existing = await conn.fetchrow("SELECT id FROM clarity_app.users WHERE email = $1", inv["email"])
    if existing:
        user_id = existing["id"]
    else:
        user_id = str(uuid.uuid4())
        await conn.execute(
            "INSERT INTO clarity_app.users (id, name, email, password_hash, account_state) VALUES ($1,$2,$3,$4,'active')",
            user_id, name, inv["email"], hash_password(password)
        )

    # Create membership
    membership_id = str(uuid.uuid4())
    await conn.execute(
        """INSERT INTO clarity_app.organization_memberships
           (id, user_id, organization_id, role, status, approved_at, permission_revision)
           VALUES ($1,$2,$3,'MEMBER','APPROVED',NOW(),1)
           ON CONFLICT (user_id) DO UPDATE SET status='APPROVED', approved_at=NOW()""",
        membership_id, user_id, inv["organization_id"]
    )

    # Mark invitation used
    await conn.execute("UPDATE clarity_app.invitations SET status='accepted' WHERE id=$1", inv["id"])

    session_token = await create_session(conn, user_id)
    from app.services.auth_service import get_full_user
    user_data = await get_full_user(conn, user_id)
    return {"user": user_data, "token": session_token}
