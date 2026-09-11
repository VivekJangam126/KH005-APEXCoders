import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
import asyncpg
from app.config import settings


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    key = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64)
    return f"{salt}:{key.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt, original_hash = stored_hash.split(":", 1)
        key = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64)
        return hmac.compare_digest(key.hex(), original_hash)
    except Exception:
        return False


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def create_session(conn: asyncpg.Connection, user_id: str) -> str:
    token = secrets.token_hex(32)
    token_hash = hash_token(token)
    expires_at = datetime.now(timezone.utc) + timedelta(hours=settings.SESSION_TTL_HOURS)
    await conn.execute(
        "INSERT INTO clarity_app.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
        token_hash, user_id, expires_at
    )
    return token


async def revoke_session(conn: asyncpg.Connection, token: str):
    token_hash = hash_token(token)
    await conn.execute(
        "DELETE FROM clarity_app.sessions WHERE token_hash = $1", token_hash
    )


async def get_user_by_token(conn: asyncpg.Connection, token: str) -> Optional[dict]:
    token_hash = hash_token(token)
    now = datetime.now(timezone.utc)

    row = await conn.fetchrow(
        """
        SELECT s.user_id FROM clarity_app.sessions s
        WHERE s.token_hash = $1 AND s.expires_at > $2
        """,
        token_hash, now
    )
    if not row:
        return None

    user_id = row["user_id"]
    return await get_full_user(conn, user_id)


async def get_full_user(conn: asyncpg.Connection, user_id: str) -> Optional[dict]:
    user = await conn.fetchrow(
        "SELECT id, name, email, account_state, created_at, updated_at FROM clarity_app.users WHERE id = $1",
        user_id
    )
    if not user:
        return None

    user_dict = dict(user)
    user_dict["created_at"] = str(user_dict["created_at"])
    user_dict["updated_at"] = str(user_dict["updated_at"])

    # Get membership & org
    membership = await conn.fetchrow(
        """
        SELECT m.*, o.id as org_id, o.name as org_name, o.handle as org_handle, o.state as org_state, o.created_at as org_created_at
        FROM clarity_app.organization_memberships m
        JOIN clarity_app.organizations o ON m.organization_id = o.id
        WHERE m.user_id = $1 AND m.status NOT IN ('REJECTED')
        ORDER BY m.requested_at DESC LIMIT 1
        """,
        user_id
    )

    if membership:
        user_dict["organization"] = {
            "id": membership["org_id"],
            "name": membership["org_name"],
            "handle": membership["org_handle"],
            "state": membership["org_state"],
            "createdAt": str(membership["org_created_at"]),
        }
        user_dict["membership"] = {
            "id": membership["id"],
            "userId": membership["user_id"],
            "organizationId": membership["organization_id"],
            "role": membership["role"],
            "status": membership["status"],
            "note": membership["note"],
            "rejectionReason": membership.get("rejection_reason"),
            "permissionRevision": membership["permission_revision"],
            "requestedAt": str(membership["requested_at"]),
            "approvedAt": str(membership["approved_at"]) if membership.get("approved_at") else None,
        }
        # Get permissions
        perms = await conn.fetch(
            """
            SELECT dp.*, d.display_name as db_name
            FROM clarity_app.database_permissions dp
            JOIN clarity_app.datasets d ON dp.database_id = d.id
            WHERE dp.membership_id = $1
            """,
            membership["id"]
        )
        user_dict["permissions"] = [
            {
                "databaseId": p["database_id"],
                "databaseName": p["db_name"],
                "canRead": p["can_read"],
                "canInsert": p["can_insert"],
                "canUpdate": p["can_update"],
                "canDeleteRecords": p["can_delete_records"],
                "canImportCsv": p["can_import_csv"],
                "canExport": p["can_export"],
                "version": p.get("version", 1),
            }
            for p in perms
        ]
    else:
        user_dict["organization"] = None
        user_dict["membership"] = None
        user_dict["permissions"] = []

    return user_dict
