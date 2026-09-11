import uuid
import json
import secrets
from fastapi import APIRouter, Depends, HTTPException, Body
from app.database import get_db
from app.middleware.auth_middleware import get_current_user
from app.models.schemas import ImportRequest
from app.services.csv_service import create_and_populate_table, sanitize_identifier
from app.services.schema_service import extract_schema_metadata
import asyncpg

router = APIRouter(prefix="/datasets", tags=["datasets"])


@router.get("")
async def list_datasets(
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    org_id = user.get("organization", {}).get("id") if user.get("organization") else None
    is_admin = (
        user.get("membership", {}).get("role") == "ORG_ADMIN"
        if user.get("membership")
        else False
    )

    if is_admin and org_id:
        rows = await conn.fetch(
            """SELECT d.*,
               (SELECT COUNT(*) FROM clarity_app.dataset_tables dt WHERE dt.dataset_id = d.id) as table_count,
               (SELECT COALESCE(SUM(dt.row_count),0) FROM clarity_app.dataset_tables dt WHERE dt.dataset_id = d.id) as total_rows
               FROM clarity_app.datasets d
               WHERE (d.organization_id = $1 OR (d.organization_id IS NULL AND d.owner_id = $2))
               AND d.lifecycle_state != 'deleted' ORDER BY d.created_at DESC""",
            org_id, user["id"],
        )
    elif org_id and user.get("membership"):
        rows = await conn.fetch(
            """SELECT d.*,
               (SELECT COUNT(*) FROM clarity_app.dataset_tables dt WHERE dt.dataset_id = d.id) as table_count,
               (SELECT COALESCE(SUM(dt.row_count),0) FROM clarity_app.dataset_tables dt WHERE dt.dataset_id = d.id) as total_rows
               FROM clarity_app.datasets d
               JOIN clarity_app.database_permissions p ON d.id = p.database_id
               WHERE d.organization_id = $1 AND p.membership_id = $2
               AND p.can_read = true AND d.lifecycle_state != 'deleted' ORDER BY d.created_at DESC""",
            org_id, user["membership"]["id"],
        )
    else:
        # No org — return own datasets
        rows = await conn.fetch(
            """SELECT d.*,
               (SELECT COUNT(*) FROM clarity_app.dataset_tables dt WHERE dt.dataset_id = d.id) as table_count,
               (SELECT COALESCE(SUM(dt.row_count),0) FROM clarity_app.dataset_tables dt WHERE dt.dataset_id = d.id) as total_rows
               FROM clarity_app.datasets d
               WHERE d.owner_id = $1 AND d.lifecycle_state != 'deleted' ORDER BY d.created_at DESC""",
            user["id"],
        )

    datasets = []
    for r in rows:
        d = dict(r)
        d["created_at"] = str(d["created_at"])
        d["table_count"] = int(d.get("table_count") or 0)
        d["total_rows"] = int(d.get("total_rows") or 0)
        # Attach permission summary
        d["permissions"] = {
            "isAdmin": is_admin,
            "canRead": True,
            "canInsert": is_admin,
            "canUpdate": is_admin,
            "canDeleteRecords": is_admin,
            "canImportCsv": is_admin,
            "canExport": True,
        }
        datasets.append(d)
    return {"datasets": datasets}


@router.post("/seed-sample")
async def seed_sample_dataset(
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Seed a sample college dataset for demo purposes."""
    org_id = user.get("organization", {}).get("id") if user.get("organization") else None

    dataset_id = str(uuid.uuid4())
    internal_schema = f"data_{secrets.token_hex(6)}"
    dataset_name = "Sample College Dataset"

    # Check if a sample dataset already exists for this user
    existing = await conn.fetchrow(
        "SELECT id FROM clarity_app.datasets WHERE owner_id=$1 AND display_name=$2 AND lifecycle_state!='deleted'",
        user["id"], dataset_name,
    )
    if existing:
        return {
            "success": True,
            "message": "Sample college dataset already exists.",
            "datasetId": existing["id"],
            "schemaName": internal_schema,
        }

    # Create dataset record
    await conn.execute(
        """INSERT INTO clarity_app.datasets
           (id, organization_id, owner_id, created_by, updated_by, display_name, internal_schema, engine, is_active, lifecycle_state)
           VALUES ($1,$2,$3,$3,$3,$4,$5,'PostgreSQL',true,'active')""",
        dataset_id, org_id, user["id"], dataset_name, internal_schema,
    )

    # Grant permissions if org member
    if user.get("membership"):
        await conn.execute(
            """INSERT INTO clarity_app.database_permissions
               (id,membership_id,database_id,can_read,can_insert,can_update,can_delete_records,can_import_csv,can_export,granted_by)
               VALUES ($1,$2,$3,true,true,true,true,true,true,$4)
               ON CONFLICT (membership_id, database_id) DO NOTHING""",
            str(uuid.uuid4()), user["membership"]["id"], dataset_id, user["id"],
        )

    # Create schema and tables
    await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{internal_schema}"')

    # --- Departments ---
    await conn.execute(f"""
        CREATE TABLE "{internal_schema}".departments (
            department_id SERIAL PRIMARY KEY,
            department_name TEXT NOT NULL,
            building TEXT,
            budget NUMERIC
        )
    """)
    dept_data = [
        ("Computer Science", "Tech Hall", 500000),
        ("Mathematics", "Science Block", 350000),
        ("Physics", "Science Block", 400000),
        ("English", "Arts Building", 250000),
        ("Business", "Commerce Wing", 600000),
    ]
    await conn.executemany(
        f'INSERT INTO "{internal_schema}".departments (department_name, building, budget) VALUES ($1,$2,$3)',
        dept_data,
    )

    # --- Students ---
    await conn.execute(f"""
        CREATE TABLE "{internal_schema}".students (
            student_id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            department_id INTEGER REFERENCES "{internal_schema}".departments(department_id),
            enrollment_year INTEGER,
            gpa NUMERIC(3,2),
            status TEXT DEFAULT 'active'
        )
    """)
    students_data = [
        ("Alice Johnson", "alice@college.edu", 1, 2021, 3.85, "active"),
        ("Bob Smith", "bob@college.edu", 2, 2020, 3.40, "active"),
        ("Carol White", "carol@college.edu", 1, 2022, 3.92, "active"),
        ("David Brown", "david@college.edu", 3, 2021, 3.55, "active"),
        ("Emma Davis", "emma@college.edu", 5, 2020, 3.70, "active"),
        ("Frank Miller", "frank@college.edu", 4, 2022, 3.20, "active"),
        ("Grace Wilson", "grace@college.edu", 2, 2021, 3.88, "active"),
        ("Henry Taylor", "henry@college.edu", 1, 2023, 3.65, "active"),
        ("Iris Anderson", "iris@college.edu", 5, 2020, 3.45, "active"),
        ("Jack Thomas", "jack@college.edu", 3, 2022, 3.75, "active"),
    ]
    await conn.executemany(
        f'INSERT INTO "{internal_schema}".students (name, email, department_id, enrollment_year, gpa, status) VALUES ($1,$2,$3,$4,$5,$6)',
        students_data,
    )

    # --- Courses ---
    await conn.execute(f"""
        CREATE TABLE "{internal_schema}".courses (
            course_id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            department_id INTEGER REFERENCES "{internal_schema}".departments(department_id),
            credits INTEGER DEFAULT 3,
            instructor TEXT
        )
    """)
    courses_data = [
        ("Intro to Programming", 1, 3, "Dr. Roberts"),
        ("Data Structures", 1, 3, "Dr. Chen"),
        ("Calculus I", 2, 4, "Prof. Adams"),
        ("Linear Algebra", 2, 3, "Prof. Baker"),
        ("Mechanics", 3, 3, "Dr. Newton"),
        ("Technical Writing", 4, 2, "Prof. Harper"),
        ("Business Analytics", 5, 3, "Dr. Morgan"),
    ]
    await conn.executemany(
        f'INSERT INTO "{internal_schema}".courses (title, department_id, credits, instructor) VALUES ($1,$2,$3,$4)',
        courses_data,
    )

    # --- Enrollments ---
    await conn.execute(f"""
        CREATE TABLE "{internal_schema}".enrollments (
            enrollment_id SERIAL PRIMARY KEY,
            student_id INTEGER REFERENCES "{internal_schema}".students(student_id),
            course_id INTEGER REFERENCES "{internal_schema}".courses(course_id),
            grade TEXT,
            semester TEXT
        )
    """)
    enrollments_data = [
        (1, 1, "A", "Fall 2021"), (1, 2, "A-", "Spring 2022"),
        (2, 3, "B+", "Fall 2020"), (2, 4, "B", "Spring 2021"),
        (3, 1, "A+", "Fall 2022"), (3, 7, "A", "Spring 2023"),
        (4, 5, "B+", "Fall 2021"), (5, 7, "A-", "Fall 2020"),
        (6, 6, "B", "Spring 2022"), (7, 4, "A", "Fall 2021"),
        (8, 1, "A-", "Fall 2023"), (9, 7, "B+", "Spring 2021"),
        (10, 5, "A", "Fall 2022"),
    ]
    await conn.executemany(
        f'INSERT INTO "{internal_schema}".enrollments (student_id, course_id, grade, semester) VALUES ($1,$2,$3,$4)',
        enrollments_data,
    )

    # Register tables in dataset_tables
    tables_info = [
        ("departments", 5),
        ("students", 10),
        ("courses", 7),
        ("enrollments", 13),
    ]
    for tname, rcount in tables_info:
        await conn.execute(
            "INSERT INTO clarity_app.dataset_tables (id,dataset_id,table_name,row_count,row_count_type) VALUES ($1,$2,$3,$4,'exact')",
            str(uuid.uuid4()), dataset_id, tname, rcount,
        )

    # Notification
    await conn.execute(
        """INSERT INTO clarity_app.notifications (id, owner_id, title, message, event_type, related_entity_type, related_entity_id)
           VALUES ($1,$2,'Sample dataset ready!','Sample college dataset created with 4 tables and 35 rows.','dataset_ready','dataset',$3)""",
        str(uuid.uuid4()), user["id"], dataset_id,
    )

    return {
        "success": True,
        "message": "Sample college dataset created with departments, students, courses, and enrollments.",
        "datasetId": dataset_id,
        "schemaName": internal_schema,
    }


@router.post("/import")
async def import_dataset(
    body: ImportRequest,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    # ORG_ADMIN only
    if not user.get("membership") or user["membership"].get("role") != "ORG_ADMIN":
        raise HTTPException(
            status_code=403,
            detail={"code": "FORBIDDEN", "message": "Only Organization Administrators can import datasets."},
        )

    upload = await conn.fetchrow(
        "SELECT * FROM clarity_app.ingestion_jobs WHERE id = $1 AND created_by = $2",
        body.uploadId, user["id"],
    )
    if not upload:
        raise HTTPException(
            status_code=404,
            detail={"code": "UPLOAD_NOT_FOUND", "message": "Upload not found."},
        )

    candidate_tables = json.loads(upload["candidate_tables"] or "[]")
    if not candidate_tables:
        raise HTTPException(
            status_code=400,
            detail={"code": "NO_DATA", "message": "No tabular data found to import."},
        )

    table_data = candidate_tables[0]
    columns = table_data["columns"]

    # Fetch staged rows
    staged = await conn.fetch(
        "SELECT data_json FROM clarity_app.staged_rows WHERE job_id = $1 AND table_name = $2 ORDER BY row_index ASC",
        body.uploadId, table_data["name"],
    )
    all_rows = [
        r["data_json"] if isinstance(r["data_json"], dict) else json.loads(r["data_json"])
        for r in staged
    ]

    dataset_name = (body.datasetName or upload["source_file_name"].rsplit(".", 1)[0]).strip()
    table_name = sanitize_identifier(body.tableName or table_data["name"])
    dataset_id = str(uuid.uuid4())
    internal_schema = f"data_{secrets.token_hex(6)}"
    org_id = user.get("organization", {}).get("id") if user.get("organization") else None

    await conn.execute(
        """INSERT INTO clarity_app.datasets
           (id, organization_id, owner_id, created_by, updated_by, display_name, internal_schema, engine, is_active, lifecycle_state)
           VALUES ($1,$2,$3,$3,$3,$4,$5,'PostgreSQL',true,'active')""",
        dataset_id, org_id, user["id"], dataset_name, internal_schema,
    )

    if user.get("membership"):
        await conn.execute(
            """INSERT INTO clarity_app.database_permissions
               (id, membership_id, database_id, can_read, can_insert, can_update, can_delete_records, can_import_csv, can_export, granted_by)
               VALUES ($1,$2,$3,true,true,true,true,true,true,$4)
               ON CONFLICT (membership_id, database_id) DO NOTHING""",
            str(uuid.uuid4()), user["membership"]["id"], dataset_id, user["id"],
        )

    row_count = await create_and_populate_table(conn, internal_schema, table_name, columns, all_rows)

    await conn.execute(
        "INSERT INTO clarity_app.dataset_tables (id, dataset_id, table_name, row_count, row_count_type) VALUES ($1,$2,$3,$4,'exact')",
        str(uuid.uuid4()), dataset_id, table_name, row_count,
    )

    schema_meta = await extract_schema_metadata(conn, dataset_id, internal_schema)

    await conn.execute(
        "UPDATE clarity_app.ingestion_jobs SET extraction_status='COMPLETED', lifecycle_status='confirmed', created_database_id=$2 WHERE id=$1",
        body.uploadId, dataset_id,
    )
    await conn.execute("DELETE FROM clarity_app.staged_rows WHERE job_id = $1", body.uploadId)

    # Notification
    await conn.execute(
        """INSERT INTO clarity_app.notifications (id, owner_id, title, message, event_type, related_entity_type, related_entity_id)
           VALUES ($1,$2,'Your database is ready.',$3,'dataset_ready','dataset',$4)""",
        str(uuid.uuid4()), user["id"],
        f'Analytical dataset "{dataset_name}" created with {row_count} rows.',
        dataset_id,
    )

    return {
        "success": True,
        "message": "Your database is ready.",
        "dataset": {
            "id": dataset_id,
            "displayName": dataset_name,
            "internalSchema": internal_schema,
            "table": table_name,
            "rowCount": row_count,
            "schema": schema_meta,
        },
    }


@router.get("/{dataset_id}/schema")
async def get_schema(
    dataset_id: str,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    ds = await conn.fetchrow(
        "SELECT * FROM clarity_app.datasets WHERE id = $1 AND lifecycle_state != 'deleted'", dataset_id
    )
    if not ds:
        raise HTTPException(
            status_code=404,
            detail={"code": "DATASET_NOT_FOUND", "message": "Dataset not found."},
        )
    return await extract_schema_metadata(conn, dataset_id, ds["internal_schema"])


@router.post("/{dataset_id}/schema/refresh")
async def refresh_schema(
    dataset_id: str,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    ds = await conn.fetchrow(
        "SELECT * FROM clarity_app.datasets WHERE id = $1 AND lifecycle_state != 'deleted'", dataset_id
    )
    if not ds:
        raise HTTPException(
            status_code=404,
            detail={"code": "DATASET_NOT_FOUND", "message": "Dataset not found."},
        )
    schema_meta = await extract_schema_metadata(conn, dataset_id, ds["internal_schema"])
    return {"success": True, "schema": schema_meta}


@router.post("/{dataset_id}/reconnect")
async def reconnect_dataset(
    dataset_id: str,
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    try:
        await conn.fetchval("SELECT 1")
        ready = True
        engine = "PostgreSQL"
    except Exception:
        ready = False
        engine = "PostgreSQL (disconnected)"

    return {
        "success": ready,
        "engine": engine,
        "message": "Database connected and verified." if ready else "Database connection unavailable.",
    }


@router.post("/{dataset_id}/delete")
async def delete_dataset(
    dataset_id: str,
    body: dict = Body(default={}),
    conn: asyncpg.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    if not user.get("membership") or user["membership"].get("role") != "ORG_ADMIN":
        raise HTTPException(
            status_code=403,
            detail={"code": "FORBIDDEN", "message": "Only admins can delete datasets."},
        )
    ds = await conn.fetchrow(
        "SELECT * FROM clarity_app.datasets WHERE id = $1", dataset_id
    )
    if not ds:
        raise HTTPException(
            status_code=404,
            detail={"code": "DATASET_NOT_FOUND", "message": "Dataset not found."},
        )
    try:
        await conn.execute(f'DROP SCHEMA IF EXISTS "{ds["internal_schema"]}" CASCADE')
    except Exception:
        pass
    await conn.execute(
        "UPDATE clarity_app.datasets SET lifecycle_state='deleted' WHERE id=$1", dataset_id
    )
    return {"success": True, "message": "Dataset deleted."}
