from pydantic import BaseModel
from typing import Optional, List, Any
from datetime import datetime


class LoginRequest(BaseModel):
    email: str
    password: str

class RegisterOrgRequest(BaseModel):
    adminName: str
    email: str
    password: str
    orgName: str
    orgHandle: str

class UpdateProfileRequest(BaseModel):
    name: str

class OrganizationInfo(BaseModel):
    id: str
    name: str
    handle: str
    state: str
    createdAt: str

class MembershipInfo(BaseModel):
    id: str
    userId: str
    organizationId: str
    role: str
    status: str
    note: Optional[str] = None
    rejectionReason: Optional[str] = None
    permissionRevision: int
    requestedAt: str
    approvedAt: Optional[str] = None

class DatabasePermissionGrant(BaseModel):
    databaseId: str
    databaseName: Optional[str] = None
    canRead: bool
    canInsert: bool
    canUpdate: bool
    canDeleteRecords: bool
    canImportCsv: bool
    canExport: bool
    version: int

class UserOut(BaseModel):
    id: str
    name: str
    email: str
    account_state: Optional[str] = None
    organization: Optional[OrganizationInfo] = None
    membership: Optional[MembershipInfo] = None
    permissions: Optional[List[DatabasePermissionGrant]] = None
    created_at: str
    updated_at: str

class DatasetOut(BaseModel):
    id: str
    organization_id: Optional[str] = None
    owner_id: str
    display_name: str
    internal_schema: str
    engine: str
    is_active: bool
    lifecycle_state: Optional[str] = None
    table_count: Optional[int] = 0
    total_rows: Optional[int] = 0
    created_at: str

class ColumnInfo(BaseModel):
    originalName: str
    internalName: str
    detectedType: str
    isNullable: bool

class AnalyzeRequest(BaseModel):
    datasetId: str
    question: str

class ImportRequest(BaseModel):
    uploadId: str
    datasetName: Optional[str] = None
    tableName: Optional[str] = None

class ErrorResponse(BaseModel):
    code: str
    message: str
    retryable: bool = False
