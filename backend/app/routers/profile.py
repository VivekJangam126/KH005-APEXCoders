from fastapi import APIRouter, Depends
from app.database import get_db
from app.middleware.auth_middleware import get_current_user
from app.models.schemas import UpdateProfileRequest
import asyncpg

router = APIRouter(tags=["profile"])


@router.patch("/profile")
async def update_profile(body: UpdateProfileRequest, conn: asyncpg.Connection = Depends(get_db), user: dict = Depends(get_current_user)):
    name = body.name.strip()
    if not name:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail={"code": "INVALID_INPUT", "message": "Name cannot be empty."})

    await conn.execute(
        "UPDATE clarity_app.users SET name = $1, updated_at = NOW() WHERE id = $2",
        name, user["id"]
    )
    return {"user": {**user, "name": name}}
