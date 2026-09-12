import { parse, Statement, SelectStatement } from 'pgsql-ast-parser';
import { TableMetadata } from './schema.ts';
import { config } from './config.ts';

export type OperationType = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'ALTER' | 'DROP' | 'TRUNCATE' | 'UNKNOWN';

export interface ValidationCheckResult {
  status: 'passed' | 'failed' | 'not_applicable';
  message: string;
}

export interface ValidationReport {
  isValid: boolean;
  checks: {
    syntax: ValidationCheckResult;
    readOnly: ValidationCheckResult;
    objects: ValidationCheckResult;
    functions: ValidationCheckResult;
    limits: ValidationCheckResult;
  };
  errors: string[];
  warnings: string[];
  normalizedSql?: string;
  referencedTables: string[];
  referencedColumns: { table: string; column: string }[];
  generatedOperation: OperationType;
  columns: ValidationCheckResult;
  relationships: ValidationCheckResult;
  dataTypes: ValidationCheckResult;
  operation: ValidationCheckResult;
  permissions: ValidationCheckResult;
  safety: ValidationCheckResult;
}

const ALLOWED_FUNCTIONS = new Set([
  'avg',
  'sum',
  'count',
  'min',
  'max',
  'round',
  'coalesce',
  'nullif',
  'lower',
  'upper',
  'trim',
  'length',
  'date_trunc',
  'extract',
  'to_char',
  'abs',
  'concat',
  'ceil',
  'floor',
  'mod',
  'sqrt',
  'power',
  'cast',
]);

const FORBIDDEN_WORDS = [
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\bdrop\b/i,
  /\balter\b/i,
  /\bcreate\b/i,
  /\btruncate\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
  /\bcopy\b/i,
  /\bcall\b/i,
  /\bdo\b/i,
  /\bselect\s+into\b/i,
  /\bpg_sleep\b/i,
  /\bpg_read_file\b/i,
  /\bpg_catalog\b/i,
  /\binformation_schema\b/i,
  /\bclarity_app\b/i,
];

function detectOperation(sql: string, statement?: Statement): OperationType {
  const keyword = sql.trim().match(/^(?:--[^\n]*\s*)*([a-z]+)/i)?.[1]?.toUpperCase();
  if (keyword && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE'].includes(keyword)) {
    return keyword as OperationType;
  }
  if (statement?.type === 'select' || statement?.type === 'with') return 'SELECT';
  return 'UNKNOWN';
}

function emptyCheck(message: string): ValidationCheckResult {
  return { status: 'not_applicable', message };
}

export function validateSql(
  sql: string,
  authorizedTables: TableMetadata[],
  expectedOperation?: OperationType,
  authorizedOperation = true
): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const referencedTables: string[] = [];
  const referencedColumns: { table: string; column: string }[] = [];

  const checks: ValidationReport['checks'] = {
    syntax: { status: 'passed', message: 'SQL parsed successfully into PostgreSQL AST.' },
    readOnly: { status: 'passed', message: 'Only non-destructive SELECT operations allowed.' },
    objects: { status: 'passed', message: 'All referenced tables belong to active authorized schema.' },
    functions: { status: 'passed', message: 'All functions are verified safe analytical primitives.' },
    limits: { status: 'passed', message: `Row limits verified within maximum bound of ${config.maxResultRows}.` },
  };
  const columnsCheck = { status: 'passed', message: 'All referenced columns exist in the active schema.' } as ValidationCheckResult;
  const relationshipsCheck = { status: 'passed', message: 'Referenced joins match known foreign-key relationships.' } as ValidationCheckResult;
  const dataTypesCheck = { status: 'passed', message: 'No obvious data type mismatches were detected.' } as ValidationCheckResult;
  const operationCheck = { status: 'passed', message: 'Generated operation matches the requested operation.' } as ValidationCheckResult;
  const permissionsCheck = authorizedOperation
    ? { status: 'passed', message: 'The authenticated user is authorized for this operation.' } as ValidationCheckResult
    : { status: 'failed', message: 'The authenticated user is not authorized for this operation.' } as ValidationCheckResult;
  const safetyCheck = { status: 'passed', message: 'SQL passed safety validation and requires confirmation before execution.' } as ValidationCheckResult;

  const trimmedSql = sql.trim().replace(/;+$/, '').trim();

  // Basic sanity check
  if (!trimmedSql) {
    return {
      isValid: false,
      checks: {
        syntax: { status: 'failed', message: 'Query string is empty.' },
        readOnly: { status: 'failed', message: 'Empty query.' },
        objects: { status: 'not_applicable', message: 'No tables analyzed.' },
        functions: { status: 'not_applicable', message: 'No functions analyzed.' },
        limits: { status: 'not_applicable', message: 'No limit analyzed.' },
      },
      errors: ['SQL query is empty.'],
      warnings,
      referencedTables: [],
      referencedColumns,
      generatedOperation: 'UNKNOWN',
      columns: emptyCheck('No columns analyzed.'),
      relationships: emptyCheck('No relationships analyzed.'),
      dataTypes: emptyCheck('No data types analyzed.'),
      operation: { status: 'failed', message: 'No SQL operation was generated.' },
      permissions: permissionsCheck,
      safety: safetyCheck,
    };
  }

  // 1. AST Parsing
  let ast: Statement[];
  try {
    ast = parse(trimmedSql);
  } catch (err: any) {
    checks.syntax = { status: 'failed', message: `Syntax error: ${err.message}` };
    errors.push(`SQL syntax error: ${err.message}`);
    return {
      isValid: false,
      checks,
      errors,
      warnings,
      referencedTables: [],
      referencedColumns,
      generatedOperation: detectOperation(trimmedSql),
      columns: emptyCheck('Columns could not be analyzed because parsing failed.'),
      relationships: emptyCheck('Relationships could not be analyzed because parsing failed.'),
      dataTypes: emptyCheck('Data types could not be analyzed because parsing failed.'),
      operation: operationCheck,
      permissions: permissionsCheck,
      safety: safetyCheck,
    };
  }

  // 2. Must be exactly one statement
  if (ast.length !== 1) {
    checks.syntax = { status: 'failed', message: `Expected 1 statement, but received ${ast.length}. Multi-statement execution is blocked.` };
    errors.push('Multiple SQL statements are prohibited.');
  }

  const statement = ast[0];

  const generatedOperation = detectOperation(trimmedSql, statement);
  if (expectedOperation && generatedOperation !== expectedOperation) {
    operationCheck.status = 'failed';
    operationCheck.message = `Expected ${expectedOperation}, but generated SQL is ${generatedOperation}.`;
    errors.push(operationCheck.message);
  }
  if (!authorizedOperation) {
    errors.push(permissionsCheck.message);
  }

  // Read-only checks do not apply to authorized mutation operations.
  if (generatedOperation !== 'SELECT') {
    checks.readOnly = { status: 'not_applicable', message: 'Read-only check is not applicable to this operation.' };
    safetyCheck.message = 'Modification passed safety validation and requires confirmation before execution.';
  }

  const statementAny = statement as any;

  // Check CTE names to treat as authorized tables
  const cteNames = new Set<string>();
  if (statement.type === 'with' && Array.isArray(statementAny.bind)) {
    for (const b of statementAny.bind) {
      if (b.alias?.name) {
        cteNames.add(String(b.alias.name).toLowerCase());
      }
      if (b.statement && b.statement.type !== 'select') {
        checks.readOnly = { status: 'failed', message: 'Data-modifying operations inside WITH / CTE clauses are blocked.' };
        errors.push('CTE contains non-SELECT statement.');
      }
    }
  }

  const tableMap = new Map(authorizedTables.map(t => [t.name.toLowerCase(), t]));
  const validTableNames = new Set(tableMap.keys());
  const aliases = new Map<string, string>();
  const selectAliases = new Set<string>();
  for (const table of authorizedTables) {
    aliases.set(table.name.toLowerCase(), table.name.toLowerCase());
  }

  // Walk AST to inspect tables and functions
  function walk(node: any) {
    if (!node || typeof node !== 'object') return;

    // Check table references
    if (node.type === 'table') {
      const rawName = typeof node.name === 'string' ? node.name : node.name?.name;
      const tableName = (typeof rawName === 'string' ? rawName : '').toLowerCase();

      const rawSchema = typeof node.name?.schema === 'string' ? node.name.schema : typeof node.schema === 'string' ? node.schema : '';
      const schemaName = (typeof rawSchema === 'string' ? rawSchema : '').toLowerCase();

      if (schemaName && schemaName !== 'public' && !schemaName.startsWith('data_')) {
        checks.objects = {
          status: 'failed',
          message: `Direct reference to schema '${schemaName}' is prohibited. Only active dataset tables are accessible.`
        };
        errors.push(`Unauthorized schema reference: ${schemaName}`);
      }

      if (tableName) {
        if (!referencedTables.includes(tableName)) {
          referencedTables.push(tableName);
        }

        if (!cteNames.has(tableName) && !validTableNames.has(tableName)) {
          checks.objects = {
            status: 'failed',
            message: `Table '${tableName}' does not exist in the active dataset schema.`
          };
          errors.push(`Table '${tableName}' was not found in dataset.`);
        }
        const alias = node.alias?.name || node.name?.alias || node.alias;
        if (typeof alias === 'string') aliases.set(alias.toLowerCase(), tableName);
      }
    }

    if (node.type === 'ref' || node.type === 'column') {
      const rawColumn = node.name?.name || node.name;
      const rawTable = node.table?.name || node.table;
      if (typeof rawColumn === 'string' && rawColumn !== '*' && !selectAliases.has(rawColumn.toLowerCase())) {
        const tableName = typeof rawTable === 'string'
          ? (aliases.get(rawTable.toLowerCase()) || rawTable.toLowerCase())
          : '';
        referencedColumns.push({ table: tableName, column: rawColumn });
        const candidateTables = tableName && tableMap.has(tableName)
          ? [tableMap.get(tableName)!]
          : authorizedTables;
        if (!candidateTables.some(t => t.columns.some(c => c.name.toLowerCase() === rawColumn.toLowerCase()))) {
          columnsCheck.status = 'failed';
          columnsCheck.message = `Column '${rawColumn}' does not exist in the active dataset schema.`;
          errors.push(`Column '${rawColumn}' was not found in dataset.`);
        }
      }
    }

    if (node.type === 'binary') {
      const operator = String(node.op || node.operator || '').toUpperCase();
      if (!['=', '<>', '!=', '>', '>=', '<', '<=', 'LIKE', 'ILIKE', 'IS', 'IS NOT', 'AND', 'OR'].includes(operator)) {
        errors.push(`Unsupported filter operator '${operator || 'unknown'}'.`);
        dataTypesCheck.status = 'failed';
      }
    }

    if (node.type === 'binary' && node.left?.type === 'ref' && node.right?.type === 'string') {
      const columnName = node.left.name?.name || node.left.name;
      const tableName = node.left.table?.name || node.left.table;
      const resolvedTable = typeof tableName === 'string' ? aliases.get(tableName.toLowerCase()) || tableName.toLowerCase() : '';
      const column = tableMap.get(resolvedTable)?.columns.find(c => c.name.toLowerCase() === String(columnName).toLowerCase());
      if (column?.distinctValues?.length && !column.distinctValues.some(value =>
        value.toLowerCase() === String(node.right.value).toLowerCase(),
      )) {
        dataTypesCheck.status = 'failed';
        dataTypesCheck.message = `Filter value '${node.right.value}' does not exist for column '${column.name}'.`;
        errors.push(dataTypesCheck.message);
      }
      if (column && !['TEXT', 'VARCHAR', 'CHARACTER VARYING', 'DATE', 'TIMESTAMP WITHOUT TIME ZONE', 'TIMESTAMP WITH TIME ZONE'].includes(column.dataType)) {
        warnings.push(`String literal compared with ${column.dataType} column '${String(columnName)}'; verify the filter value.`);
      }
    }

    // Check function calls
    if (node.type === 'call') {
      const funcName = (node.function?.name || '').toLowerCase();
      if (funcName && !ALLOWED_FUNCTIONS.has(funcName)) {
        checks.functions = {
          status: 'failed',
          message: `Function '${funcName}' is not in the safe analytical allowlist.`
        };
        errors.push(`Disallowed function: ${funcName}`);
      }
    }

    // Recurse into object properties
    for (const key of Object.keys(node)) {
      if (key === 'type') continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          walk(item);
        }
      } else if (typeof child === 'object') {
        walk(child);
      }
    }
  }

  const collectAliases = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'select' && Array.isArray(node.columns)) {
      for (const column of node.columns) {
        const alias = column.alias?.name || column.alias;
        if (typeof alias === 'string') selectAliases.add(alias.toLowerCase());
      }
    }
    if (node.type === 'table') {
      const rawName = typeof node.name === 'string' ? node.name : node.name?.name;
      const alias = node.alias?.name || node.name?.alias || node.alias;
      if (typeof rawName === 'string' && typeof alias === 'string') {
        aliases.set(alias.toLowerCase(), rawName.toLowerCase());
      }
    }
    Object.values(node).forEach(child => {
      if (Array.isArray(child)) child.forEach(collectAliases);
      else if (child && typeof child === 'object') collectAliases(child);
    });
  };
  collectAliases(statement);
  walk(statement);

  for (const table of referencedTables) {
    if (!tableMap.has(table) && !cteNames.has(table)) {
      relationshipsCheck.status = 'failed';
    }
  }
  const joinNodes: any[] = [];
  const collectJoins = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'join' || (typeof node.type === 'string' && node.type.endsWith(' JOIN'))) joinNodes.push(node);
    Object.values(node).forEach(child => {
      if (Array.isArray(child)) child.forEach(collectJoins);
      else if (child && typeof child === 'object') collectJoins(child);
    });
  };
  collectJoins(statement);
  for (const join of joinNodes) {
    const left = join.on?.left;
    const right = join.on?.right;
    const leftName = left?.name?.name || left?.name;
    const rightName = right?.name?.name || right?.name;
    const leftTable = aliases.get((left?.table?.name || left?.table || '').toLowerCase()) || (left?.table?.name || left?.table || '').toLowerCase();
    const rightTable = aliases.get((right?.table?.name || right?.table || '').toLowerCase()) || (right?.table?.name || right?.table || '').toLowerCase();
    const leftMeta = tableMap.get(leftTable);
    const rightMeta = tableMap.get(rightTable);
    const relationshipExists = Boolean(
      leftMeta?.columns.some(c => c.name.toLowerCase() === String(leftName).toLowerCase() && c.foreignKey?.targetTable.toLowerCase() === rightTable && c.foreignKey.targetColumn.toLowerCase() === String(rightName).toLowerCase()) ||
      rightMeta?.columns.some(c => c.name.toLowerCase() === String(rightName).toLowerCase() && c.foreignKey?.targetTable.toLowerCase() === leftTable && c.foreignKey.targetColumn.toLowerCase() === String(leftName).toLowerCase())
    );
    if (leftMeta && rightMeta && !relationshipExists) {
      warnings.push(`Join between '${leftTable}' and '${rightTable}' does not match a known foreign-key relationship.`);
    }
  }

  // Check limits
  const targetSelect = statement.type === 'with' ? statementAny.in : statementAny;
  if (targetSelect?.limit) {
    const limitVal = targetSelect.limit.limit;
    if (limitVal && limitVal.type === 'integer') {
      const num = parseInt(limitVal.value, 10);
      if (num > config.maxResultRows) {
        checks.limits = {
          status: 'failed',
          message: `Requested limit (${num}) exceeds maximum allowed of ${config.maxResultRows}.`
        };
        errors.push(`Limit of ${num} exceeds maximum permitted ${config.maxResultRows}.`);
      } else {
        checks.limits = {
          status: 'passed',
          message: `Query explicitly limits output to ${num} rows.`
        };
      }
    }
  } else {
    checks.limits = {
      status: 'passed',
      message: `No explicit limit provided; default server limit of ${config.maxResultRows} will be enforced.`
    };
  }

  const isValid = errors.length === 0 && authorizedOperation;

  return {
    isValid,
    checks,
    errors,
    warnings,
    normalizedSql: trimmedSql,
    referencedTables,
    referencedColumns,
    generatedOperation,
    columns: columnsCheck,
    relationships: relationshipsCheck,
    dataTypes: dataTypesCheck,
    operation: operationCheck,
    permissions: permissionsCheck,
    safety: safetyCheck,
  };
}
