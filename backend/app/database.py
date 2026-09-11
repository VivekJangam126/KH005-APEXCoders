from typing import AsyncGenerator
import asyncpg
from app.config import settings

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        if not settings.DATABASE_URL:
            raise RuntimeError("DATABASE_URL is not configured.")

        _pool = await asyncpg.create_pool(
            dsn=settings.DATABASE_URL,
            min_size=2,
            max_size=20,
            command_timeout=max(settings.QUERY_TIMEOUT_MS / 1000, 15),
            # Required for Supabase / pgbouncer in transaction mode
            statement_cache_size=0,
        )
    return _pool


async def get_db() -> AsyncGenerator[asyncpg.Connection, None]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("SET statement_timeout = '15s'")
        yield conn


async def close_pool():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


async def run_migrations(pool: asyncpg.Pool):
    """Initialize all required tables for the ClaritySQL application."""
    async with pool.acquire() as conn:
        print("[DB Migrations] Running schema migrations...")
        await conn.execute("""
            CREATE SCHEMA IF NOT EXISTS clarity_app;

            CREATE TABLE IF NOT EXISTS clarity_app.organizations (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              handle TEXT UNIQUE NOT NULL,
              state TEXT NOT NULL DEFAULT 'active',
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.users (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              email TEXT UNIQUE NOT NULL,
              password_hash TEXT NOT NULL,
              account_state TEXT NOT NULL DEFAULT 'active',
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.organization_memberships (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES clarity_app.users(id) ON DELETE CASCADE,
              organization_id TEXT NOT NULL REFERENCES clarity_app.organizations(id) ON DELETE CASCADE,
              role TEXT NOT NULL,
              status TEXT NOT NULL,
              note TEXT,
              rejection_reason TEXT,
              permission_revision INTEGER NOT NULL DEFAULT 1,
              requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
              approved_at TIMESTAMPTZ,
              approved_by TEXT REFERENCES clarity_app.users(id),
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(user_id)
            );

            CREATE TABLE IF NOT EXISTS clarity_app.database_permissions (
              id TEXT PRIMARY KEY,
              membership_id TEXT NOT NULL REFERENCES clarity_app.organization_memberships(id) ON DELETE CASCADE,
              database_id TEXT NOT NULL,
              can_read BOOLEAN NOT NULL DEFAULT true,
              can_insert BOOLEAN NOT NULL DEFAULT false,
              can_update BOOLEAN NOT NULL DEFAULT false,
              can_delete_records BOOLEAN NOT NULL DEFAULT false,
              can_import_csv BOOLEAN NOT NULL DEFAULT false,
              can_export BOOLEAN NOT NULL DEFAULT false,
              version INTEGER NOT NULL DEFAULT 1,
              granted_by TEXT REFERENCES clarity_app.users(id),
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
              UNIQUE(membership_id, database_id)
            );

            CREATE TABLE IF NOT EXISTS clarity_app.invitations (
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL REFERENCES clarity_app.organizations(id) ON DELETE CASCADE,
              name TEXT NOT NULL,
              email TEXT NOT NULL,
              token_hash TEXT UNIQUE NOT NULL,
              permissions_json TEXT NOT NULL DEFAULT '[]',
              invited_by TEXT NOT NULL REFERENCES clarity_app.users(id),
              status TEXT NOT NULL DEFAULT 'pending',
              expires_at TIMESTAMPTZ NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.sessions (
              token_hash TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES clarity_app.users(id) ON DELETE CASCADE,
              expires_at TIMESTAMPTZ NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.datasets (
              id TEXT PRIMARY KEY,
              organization_id TEXT REFERENCES clarity_app.organizations(id) ON DELETE CASCADE,
              owner_id TEXT NOT NULL REFERENCES clarity_app.users(id) ON DELETE CASCADE,
              created_by TEXT REFERENCES clarity_app.users(id),
              updated_by TEXT REFERENCES clarity_app.users(id),
              display_name TEXT NOT NULL,
              description TEXT,
              internal_schema TEXT NOT NULL UNIQUE,
              engine TEXT NOT NULL DEFAULT 'PostgreSQL',
              access_policy TEXT NOT NULL DEFAULT 'ALL_MEMBERS',
              is_active BOOLEAN NOT NULL DEFAULT true,
              lifecycle_state TEXT NOT NULL DEFAULT 'active',
              schema_revision INTEGER NOT NULL DEFAULT 1,
              data_revision INTEGER NOT NULL DEFAULT 1,
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.dataset_tables (
              id TEXT PRIMARY KEY,
              dataset_id TEXT NOT NULL REFERENCES clarity_app.datasets(id) ON DELETE CASCADE,
              table_name TEXT NOT NULL,
              row_count BIGINT NOT NULL DEFAULT 0,
              row_count_type TEXT NOT NULL DEFAULT 'exact',
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.schema_snapshots (
              id TEXT PRIMARY KEY,
              dataset_id TEXT NOT NULL REFERENCES clarity_app.datasets(id) ON DELETE CASCADE,
              schema_json TEXT NOT NULL,
              fingerprint TEXT NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.analyses (
              id TEXT PRIMARY KEY,
              dataset_id TEXT NOT NULL REFERENCES clarity_app.datasets(id) ON DELETE CASCADE,
              owner_id TEXT NOT NULL REFERENCES clarity_app.users(id) ON DELETE CASCADE,
              question TEXT NOT NULL,
              intent_json TEXT DEFAULT '{}',
              summary TEXT DEFAULT '',
              measure TEXT,
              aggregation TEXT,
              group_by_json TEXT DEFAULT '[]',
              filters_json TEXT DEFAULT '[]',
              sort_json TEXT DEFAULT '[]',
              clarification_question TEXT,
              status TEXT NOT NULL DEFAULT 'ready',
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.sql_attempts (
              id TEXT PRIMARY KEY,
              analysis_id TEXT NOT NULL REFERENCES clarity_app.analyses(id) ON DELETE CASCADE,
              attempt_number INTEGER NOT NULL DEFAULT 1,
              sql_text TEXT NOT NULL,
              params_json TEXT NOT NULL DEFAULT '[]',
              validation_report_json TEXT NOT NULL DEFAULT '{}',
              correction_reason TEXT,
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.previews (
              id TEXT PRIMARY KEY,
              analysis_id TEXT NOT NULL REFERENCES clarity_app.analyses(id) ON DELETE CASCADE,
              owner_id TEXT NOT NULL REFERENCES clarity_app.users(id) ON DELETE CASCADE,
              dataset_id TEXT NOT NULL REFERENCES clarity_app.datasets(id) ON DELETE CASCADE,
              schema_fingerprint TEXT NOT NULL,
              sql_text TEXT NOT NULL,
              params_json TEXT NOT NULL DEFAULT '[]',
              result_limit INTEGER NOT NULL DEFAULT 1000,
              validation_report_json TEXT NOT NULL DEFAULT '{}',
              digest TEXT NOT NULL,
              is_consumed BOOLEAN NOT NULL DEFAULT false,
              expires_at TIMESTAMPTZ NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.executions (
              id TEXT PRIMARY KEY,
              preview_id TEXT NOT NULL REFERENCES clarity_app.previews(id) ON DELETE CASCADE,
              analysis_id TEXT REFERENCES clarity_app.analyses(id) ON DELETE CASCADE,
              owner_id TEXT NOT NULL REFERENCES clarity_app.users(id) ON DELETE CASCADE,
              dataset_id TEXT REFERENCES clarity_app.datasets(id),
              idempotency_key TEXT UNIQUE,
              status TEXT NOT NULL DEFAULT 'running',
              duration_ms INTEGER,
              error_message TEXT,
              error_category TEXT,
              started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
              completed_at TIMESTAMPTZ
            );

            CREATE TABLE IF NOT EXISTS clarity_app.result_snapshots (
              id TEXT PRIMARY KEY,
              execution_id TEXT NOT NULL UNIQUE REFERENCES clarity_app.executions(id) ON DELETE CASCADE,
              columns_json TEXT NOT NULL DEFAULT '[]',
              rows_json TEXT NOT NULL DEFAULT '[]',
              total_rows INTEGER NOT NULL DEFAULT 0,
              is_capped BOOLEAN NOT NULL DEFAULT false,
              size_bytes BIGINT NOT NULL DEFAULT 0,
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.insights (
              id TEXT PRIMARY KEY,
              execution_id TEXT NOT NULL UNIQUE REFERENCES clarity_app.executions(id) ON DELETE CASCADE,
              summary TEXT NOT NULL DEFAULT '',
              explanation TEXT NOT NULL DEFAULT '',
              evidence_json TEXT NOT NULL DEFAULT '[]',
              chart_recommendation_json TEXT NOT NULL DEFAULT '{}',
              status TEXT NOT NULL DEFAULT 'ready',
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.notifications (
              id TEXT PRIMARY KEY,
              owner_id TEXT NOT NULL REFERENCES clarity_app.users(id) ON DELETE CASCADE,
              title TEXT NOT NULL,
              message TEXT NOT NULL,
              event_type TEXT NOT NULL,
              related_entity_type TEXT,
              related_entity_id TEXT,
              is_read BOOLEAN NOT NULL DEFAULT false,
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.audit_events (
              id TEXT PRIMARY KEY,
              organization_id TEXT NOT NULL REFERENCES clarity_app.organizations(id) ON DELETE CASCADE,
              actor_id TEXT REFERENCES clarity_app.users(id),
              actor_name TEXT,
              actor_email TEXT,
              action TEXT NOT NULL,
              target_type TEXT NOT NULL,
              target_id TEXT,
              target_name TEXT,
              summary TEXT NOT NULL,
              details_json TEXT DEFAULT '{}',
              outcome TEXT NOT NULL DEFAULT 'success',
              affected_rows INTEGER DEFAULT 0,
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.operation_previews (
              id TEXT PRIMARY KEY,
              actor_id TEXT NOT NULL REFERENCES clarity_app.users(id) ON DELETE CASCADE,
              organization_id TEXT REFERENCES clarity_app.organizations(id) ON DELETE CASCADE,
              database_id TEXT NOT NULL REFERENCES clarity_app.datasets(id) ON DELETE CASCADE,
              table_name TEXT NOT NULL,
              operation TEXT NOT NULL,
              sql_text TEXT,
              plan_json TEXT NOT NULL DEFAULT '{}',
              target_record_identities_json TEXT DEFAULT '[]',
              expected_affected_count INTEGER NOT NULL DEFAULT 0,
              permission_revision INTEGER NOT NULL DEFAULT 1,
              schema_revision INTEGER NOT NULL DEFAULT 1,
              data_revision INTEGER NOT NULL DEFAULT 1,
              digest TEXT NOT NULL,
              is_consumed BOOLEAN NOT NULL DEFAULT false,
              expires_at TIMESTAMPTZ NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.ingestion_jobs (
              id TEXT PRIMARY KEY,
              organization_id TEXT REFERENCES clarity_app.organizations(id) ON DELETE CASCADE,
              created_by TEXT NOT NULL REFERENCES clarity_app.users(id),
              source_file_name TEXT NOT NULL,
              source_file_type TEXT NOT NULL DEFAULT 'text/csv',
              source_file_size BIGINT NOT NULL DEFAULT 0,
              source_hash TEXT NOT NULL DEFAULT '',
              format TEXT NOT NULL DEFAULT '.csv',
              parser_version TEXT NOT NULL DEFAULT '1.0',
              extraction_status TEXT NOT NULL DEFAULT 'READY_FOR_REVIEW',
              source_coverage JSONB DEFAULT '{}',
              candidate_tables JSONB DEFAULT '[]',
              selected_tables JSONB DEFAULT '[]',
              column_mappings JSONB DEFAULT '{}',
              inferred_types JSONB DEFAULT '{}',
              total_rows_per_table JSONB DEFAULT '{}',
              issues JSONB DEFAULT '[]',
              transformations JSONB DEFAULT '[]',
              source_references JSONB DEFAULT '{}',
              proposed_relationships JSONB DEFAULT '[]',
              plan_revision INTEGER NOT NULL DEFAULT 1,
              plan_hash TEXT NOT NULL DEFAULT '',
              expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
              confirmed_at TIMESTAMPTZ,
              created_database_id TEXT,
              lifecycle_status TEXT NOT NULL DEFAULT 'staged',
              raw_file_path TEXT DEFAULT '',
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS clarity_app.staged_rows (
              id TEXT PRIMARY KEY,
              job_id TEXT NOT NULL REFERENCES clarity_app.ingestion_jobs(id) ON DELETE CASCADE,
              table_name TEXT NOT NULL,
              row_index INTEGER NOT NULL,
              data_json JSONB NOT NULL,
              raw_source_ref JSONB,
              is_excluded BOOLEAN NOT NULL DEFAULT false,
              created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_user ON clarity_app.sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_datasets_owner ON clarity_app.datasets(owner_id);
            CREATE INDEX IF NOT EXISTS idx_datasets_org ON clarity_app.datasets(organization_id);
            CREATE INDEX IF NOT EXISTS idx_memberships_user ON clarity_app.organization_memberships(user_id);
            CREATE INDEX IF NOT EXISTS idx_memberships_org ON clarity_app.organization_memberships(organization_id);
            CREATE INDEX IF NOT EXISTS idx_db_perms_membership ON clarity_app.database_permissions(membership_id);
            CREATE INDEX IF NOT EXISTS idx_db_perms_db ON clarity_app.database_permissions(database_id);
            CREATE INDEX IF NOT EXISTS idx_analyses_owner ON clarity_app.analyses(owner_id);
            CREATE INDEX IF NOT EXISTS idx_analyses_dataset ON clarity_app.analyses(dataset_id);
            CREATE INDEX IF NOT EXISTS idx_executions_owner ON clarity_app.executions(owner_id);
            CREATE INDEX IF NOT EXISTS idx_notifications_owner ON clarity_app.notifications(owner_id, is_read);
            CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_user ON clarity_app.ingestion_jobs(created_by);
            CREATE INDEX IF NOT EXISTS idx_staged_rows_job ON clarity_app.staged_rows(job_id, table_name, row_index);
        """)

        # Safe column additions for existing deployments
        alter_statements = [
            "ALTER TABLE clarity_app.executions ADD COLUMN IF NOT EXISTS analysis_id TEXT",
            "ALTER TABLE clarity_app.executions ADD COLUMN IF NOT EXISTS dataset_id TEXT",
            "ALTER TABLE clarity_app.executions ADD COLUMN IF NOT EXISTS idempotency_key TEXT",
            "ALTER TABLE clarity_app.datasets ADD COLUMN IF NOT EXISTS access_policy TEXT DEFAULT 'ALL_MEMBERS'",
            "ALTER TABLE clarity_app.datasets ADD COLUMN IF NOT EXISTS schema_revision INTEGER DEFAULT 1",
            "ALTER TABLE clarity_app.datasets ADD COLUMN IF NOT EXISTS data_revision INTEGER DEFAULT 1",
            "ALTER TABLE clarity_app.datasets ADD COLUMN IF NOT EXISTS description TEXT",
            "ALTER TABLE clarity_app.users ADD COLUMN IF NOT EXISTS account_state TEXT DEFAULT 'active'",
            "ALTER TABLE clarity_app.analyses ADD COLUMN IF NOT EXISTS measure TEXT",
            "ALTER TABLE clarity_app.analyses ADD COLUMN IF NOT EXISTS aggregation TEXT",
            "ALTER TABLE clarity_app.ingestion_jobs ALTER COLUMN organization_id DROP NOT NULL",
        ]
        for stmt in alter_statements:
            try:
                await conn.execute(stmt)
            except Exception:
                pass  # Ignore if column already exists or constraint already dropped

        print("[DB Migrations] Migrations complete.")
