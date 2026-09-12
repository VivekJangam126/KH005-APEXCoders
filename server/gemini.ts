import { GoogleGenAI, Type, Schema } from '@google/genai';
import { config } from './config.ts';
import { ColumnMetadata, TableMetadata } from './schema.ts';
import { validateSql, ValidationReport } from './validator.ts';
import { OperationType } from './validator.ts';

let aiClient: GoogleGenAI | null = null;

function getAiClient(): GoogleGenAI | null {
  if (!config.geminiApiKey) {
    return null;
  }

  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return aiClient;
}

export interface QuestionInterpretation {
  status: 'ready' | 'needs_clarification' | 'unsupported' | 'out_of_scope';
  validation: {
    status: 'valid' | 'needs_clarification' | 'out_of_scope' | 'unsupported';
    reason?: string;
    suggestions?: string[];
  };
  operation: OperationType;
  targetEntities: string[];
  metrics: string[];
  summary: string;
  measure?: string | null;
  aggregation?: string | null;
  groupBy: string[];
  filters: { field: string; op: string; val: string; userValue?: string; resolvedValue?: string }[];
  sort: { field: string; direction: 'asc' | 'desc' }[];
  requestedLimit?: number | null;
  clarificationQuestion?: string | null;
  clarificationOptions?: string[];
}

export interface GroundedInsight {
  summary: string;
  explanation: string;
  evidence: string[];
  chartRecommendation: {
    type: 'bar' | 'line' | 'donut' | 'scatter' | 'value_card' | 'table';
    visualizationNeeded: boolean;
    xAxisKey?: string;
    yAxisKey?: string;
    seriesKey?: string;
    title: string;
    reasoning: string;
  };
}

function formatSchemaForPrompt(tables: TableMetadata[]): string {
  return tables
    .map(t => {
      const cols = t.columns
        .map(c => `  - ${c.name} (${c.dataType}${c.isPrimaryKey ? ', PK' : ''}${c.foreignKey ? `, FK -> ${c.foreignKey.targetTable}.${c.foreignKey.targetColumn}` : ''})`)
        .join('\n');
      return `Table: "${t.name}" (${t.rowCount} rows)\nColumns:\n${cols}`;
    })
    .join('\n\n');
}

function classifyOperation(question: string): OperationType {
  const value = question.toLowerCase();
  if (/\b(truncate|remove all records)\b/.test(value)) return 'TRUNCATE';
  if (/\b(drop|delete the old table)\b/.test(value)) return 'DROP';
  if (/\b(alter|add .* column)\b/.test(value)) return 'ALTER';
  if (/\b(delete|remove|erase)\b/.test(value)) return 'DELETE';
  if (/\b(update|increase|decrease|change .* price|set .* to)\b/.test(value)) return 'UPDATE';
  if (/\b(insert|add a new|create a new record|register)\b/.test(value)) return 'INSERT';
  if (/\b(create .* table)\b/.test(value)) return 'CREATE';
  return 'SELECT';
}

function normalizedTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function findQuestionTable(question: string, tables: TableMetadata[]): TableMetadata | undefined {
  const lower = question.toLowerCase();
  return tables.find(table => lower.includes(table.name.toLowerCase()))
    || tables.find(table => /\bstudents?\b/.test(lower)
      && (table.name.toLowerCase().includes('student')
        || table.columns.some(column => normalizedTokens(column.name).includes('student'))))
    || tables[0];
}

function findSemanticColumn(table: TableMetadata, subject: string): ColumnMetadata | undefined {
  const subjectToken = subject === 'maths' ? 'math' : subject;
  return table.columns.find(column => {
    const tokens = normalizedTokens(column.name);
    return tokens.includes(subjectToken) && tokens.some(token => /^(score|scores|mark|marks|grade|points?)$/.test(token));
  }) || table.columns.find(column => normalizedTokens(column.name).includes(subjectToken));
}

function inferQuestionFields(question: string, table?: TableMetadata) {
  const lower = question.toLowerCase();
  const filters: QuestionInterpretation['filters'] = [];
  const subjectMatch = lower.match(/\b(math(?:s)?|physics|chemistry|biology|english|science)\b/);
  const subjectColumn = subjectMatch && table ? findSemanticColumn(table, subjectMatch[1]) : undefined;
  const genderColumn = table?.columns.find(column =>
    normalizedTokens(column.name).includes('gender')
    || column.distinctValues?.some(value => /^(male|female)$/i.test(value)),
  );

  const requestedGender = lower.match(/\b(male|female)\b/)?.[1];
  if (genderColumn && requestedGender) {
    filters.push({ field: genderColumn.name, op: '=', val: requestedGender });
  }

  const comparison = lower.match(/(?:\b(?:more than|greater than|above|over)\b|>=|>)\s*(\d+(?:\.\d+)?)/)
    || lower.match(/\b(?:at least|minimum of)\s+(\d+(?:\.\d+)?)/);
  if (subjectColumn && comparison) {
    filters.push({
      field: subjectColumn.name,
      op: lower.includes('at least') || lower.includes('minimum') || lower.includes('>=') ? '>=' : '>',
      val: comparison[1],
    });
  }

  const requestedLimit = lower.match(/\b(?:top|first|last|limit)\s+(\d+)\b/i);
  const sortColumn = subjectColumn && /\b(top|highest|best|maximum)\b/.test(lower)
    ? subjectColumn.name
    : undefined;
  return {
    targetEntities: table ? [table.name] : [],
    filters,
    requestedLimit: requestedLimit ? Number(requestedLimit[1]) : null,
    sort: sortColumn ? [{ field: sortColumn, direction: 'desc' as const }] : [],
    subjectColumn,
    subject: subjectMatch?.[1],
  };
}

function validateQuestion(question: string, tables: TableMetadata[]): {
  status: 'valid' | 'needs_clarification' | 'unsupported';
  operation: OperationType;
  reason?: string;
  suggestions?: string[];
  clarificationOptions?: string[];
} {
  const normalized = question.trim();
  const lower = normalized.toLowerCase();
  const operation = classifyOperation(normalized);
  if (!normalized) {
    return { status: 'unsupported' as const, operation, reason: 'A database question is required.' };
  }
  const table = findQuestionTable(question, tables);
  const inferred = inferQuestionFields(question, table);
  const subjectRequested = /\b(math(?:s)?|physics|chemistry|biology|english|science)\b/.test(lower);
  if (operation === 'SELECT' && subjectRequested && !inferred.subjectColumn) {
    return {
      status: 'unsupported',
      operation,
      reason: 'The requested subject score column does not exist in the connected dataset.',
    };
  }
  if (operation === 'SELECT' && /\b(male|female)\b/.test(lower) && !inferred.filters.some(filter => filter.field.toLowerCase() === 'gender')) {
    return {
      status: 'unsupported',
      operation,
      reason: 'The requested gender column or value does not exist in the connected dataset.',
    };
  }
  const numericColumns = tables.flatMap(table => table.columns.filter(column =>
    ['INTEGER', 'BIGINT', 'NUMERIC', 'DOUBLE PRECISION', 'REAL', 'DECIMAL'].includes(column.dataType)
  ));
  const metricWords = normalizedTokens(lower).filter(token =>
    !['a', 'an', 'the', 'of', 'for', 'in', 'on', 'by', 'and', 'or', 'to', 'from', 'show', 'list', 'get', 'give', 'what', 'who', 'compare', 'analyze', 'analyse', 'students', 'records', 'data', 'best', 'better', 'has', 'have', 'with', 'low'].includes(token)
  );
  const metricColumns = numericColumns.filter(column => {
    const columnTokens = normalizedTokens(column.name);
    return metricWords.some(word => columnTokens.includes(word) || columnTokens.some(token => token.includes(word) || word.includes(token)));
  });
  const asksForMetric = /\b(compare|show|list|get|give|what|who|analy[sz]e|best|better|low)\b/.test(lower);
  const unclearMetric = metricColumns.length > 1
    || (metricColumns.length === 0 && numericColumns.length > 1 && /\b(compare|best|better|performance|attendance|sales)\b/.test(lower));
  if (operation === 'SELECT' && asksForMetric && unclearMetric) {
    const options = (metricColumns.length > 0 ? metricColumns : numericColumns).map(column => column.name);
    return {
      status: 'needs_clarification',
      operation,
      reason: `I couldn't confidently determine what "${metricWords.join(' ')}" refers to.`,
      clarificationOptions: options,
    };
  }
  if (operation === 'SELECT' && /\b(show|list|give|get|analy[sz]e)\b/.test(lower) &&
      /\b(sales|revenue|income|value|amount|price)\b/.test(lower) &&
      numericColumns.length > 1 &&
      !/\b(total|sum|average|avg|count|minimum|maximum|min|max|by|per|top|bottom)\b/.test(lower)) {
    return {
      status: 'needs_clarification',
      operation,
      reason: 'The requested metric or grouping is ambiguous.',
      suggestions: ['Show total sales', 'Show sales by product', 'Show sales by month'],
    };
  }
  return { status: 'valid' as const, operation };
}

interface FilterResolutionIssue {
  filter: QuestionInterpretation['filters'][number];
  kind: 'ambiguous' | 'not_found';
  candidates: string[];
}

function normalizeIdentifierValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveStoredValue(value: string, actualValues: string[]): { value?: string; candidates: string[] } {
  const exact = actualValues.filter(actual => actual.toLowerCase() === value.toLowerCase());
  if (exact.length === 1) return { value: exact[0], candidates: exact };
  if (exact.length > 1) return { candidates: exact };

  const normalized = normalizeIdentifierValue(value);
  const normalizedMatches = actualValues.filter(actual => normalizeIdentifierValue(actual) === normalized);
  if (normalizedMatches.length === 1) return { value: normalizedMatches[0], candidates: normalizedMatches };
  if (normalizedMatches.length > 1) return { candidates: normalizedMatches };

  const suffixMatches = actualValues.filter(actual => {
    const actualNormalized = normalizeIdentifierValue(actual);
    if (!actualNormalized.endsWith(normalized) || actualNormalized.length === normalized.length) return false;
    const prefix = actualNormalized.slice(0, -normalized.length);
    return !/[a-z0-9]$/.test(prefix) || (/^\d+$/.test(normalized) && Number(actualNormalized.slice(-normalized.length)) === Number(normalized));
  });
  const prefixMatches = actualValues.filter(actual => {
    const actualNormalized = normalizeIdentifierValue(actual);
    if (!actualNormalized.startsWith(normalized) || actualNormalized.length === normalized.length) return false;
    const suffix = actualNormalized.slice(normalized.length);
    return !/[a-z0-9]/.test(suffix) || (/^\d+$/.test(normalized) && Number(actualNormalized.slice(0, normalized.length)) === Number(normalized));
  });
  const candidates = [...new Set([...suffixMatches, ...prefixMatches])];
  return candidates.length === 1 ? { value: candidates[0], candidates } : { candidates };
}

export function resolveFilterValues(
  interpretation: QuestionInterpretation,
  tables: TableMetadata[],
): { interpretation: QuestionInterpretation; issues: FilterResolutionIssue[] } {
  const issues: FilterResolutionIssue[] = [];
  const resolvedFilters = interpretation.filters.map(filter => {
    const column = tables.flatMap(table => table.columns)
      .find(candidate => candidate.name.toLowerCase() === filter.field.toLowerCase());
    if (!column || !column.distinctValues || ['>', '<', '>=', '<='].includes(filter.op)) return filter;
    const userValue = filter.userValue || filter.val;
    const resolution = resolveStoredValue(userValue, column.distinctValues);
    if (!resolution.value) {
      issues.push({ filter, kind: resolution.candidates.length > 1 ? 'ambiguous' : 'not_found', candidates: resolution.candidates });
      return { ...filter, field: column.name, userValue };
    }
    return { ...filter, field: column.name, val: resolution.value, userValue, resolvedValue: resolution.value };
  });
  return { interpretation: { ...interpretation, filters: resolvedFilters }, issues };
}

function normalizeInterpretation(parsed: Partial<QuestionInterpretation>, question: string, tables: TableMetadata[]): QuestionInterpretation {
  const questionCheck = validateQuestion(question, tables);
  const table = findQuestionTable(question, tables);
  const inferred = inferQuestionFields(question, table);
  const hasUnboundedRequest = /\b(all|every)\b/.test(question.toLowerCase());
  const operation = parsed.operation || questionCheck.operation;
  // Scope classification is advisory; the SQL generator and AST validator
  // determine whether the requested query can actually use this schema.
  const status = questionCheck.status === 'needs_clarification'
    ? 'needs_clarification'
    : questionCheck.status === 'valid' && (parsed.status === 'unsupported' || parsed.status === 'out_of_scope')
      ? 'ready'
      : parsed.status || 'ready';
  const result: QuestionInterpretation = {
    status,
    validation: {
      status: questionCheck.status,
      reason: questionCheck.reason || parsed.validation?.reason,
      suggestions: questionCheck.suggestions || parsed.validation?.suggestions,
    },
    operation,
    targetEntities: inferred.filters.length ? inferred.targetEntities : (parsed.targetEntities?.length ? parsed.targetEntities : inferred.targetEntities),
    metrics: parsed.metrics || [],
    summary: parsed.summary || `Analyze data for: "${question}"`,
    measure: parsed.measure ?? null,
    aggregation: parsed.aggregation ?? null,
    groupBy: parsed.groupBy || [],
    filters: inferred.filters.length ? inferred.filters : (parsed.filters || []),
    sort: inferred.sort.length ? inferred.sort : (parsed.sort || []),
    requestedLimit: hasUnboundedRequest ? null : inferred.requestedLimit,
    clarificationQuestion: parsed.clarificationQuestion || (questionCheck.status === 'needs_clarification'
      ? questionCheck.clarificationOptions?.length
        ? 'What would you like to use?'
        : 'What metric or grouping would you like to use?'
      : null),
    clarificationOptions: parsed.clarificationOptions || questionCheck.clarificationOptions || [],
  };
  const resolved = resolveFilterValues(result, tables).interpretation;
  console.log('[NL->SQL] question=%j intent=%j mappedColumns=%j resolvedValues=%j',
    question,
    { operation: resolved.operation, targetEntities: resolved.targetEntities, filters: resolved.filters, sort: resolved.sort, requestedLimit: resolved.requestedLimit },
    resolved.filters.map(filter => filter.field),
    resolved.filters.map(filter => filter.val),
  );
  return resolved;
}

export function buildSmartSuggestions(question: string, tables: TableMetadata[], reason?: string): string[] {
  const table = findQuestionTable(question, tables) || tables[0];
  if (!table) return [];
  const numeric = table.columns.filter(column =>
    ['INTEGER', 'BIGINT', 'NUMERIC', 'DOUBLE PRECISION', 'REAL', 'DECIMAL'].includes(column.dataType)
  );
  const text = table.columns.filter(column =>
    /CHAR|TEXT|UUID|NAME/i.test(column.dataType) && !column.isPrimaryKey
  );
  const date = table.columns.find(column => /DATE|TIME/i.test(column.dataType));
  const questionTokens = normalizedTokens(question);
  const metric = numeric.find(column =>
    questionTokens.some(token => normalizedTokens(column.name).includes(token))
  ) || numeric[0];
  const entityColumn = text[0];
  const suggestions: string[] = [];
  const add = (value: string) => {
    if (value && !suggestions.some(item => item.toLowerCase() === value.toLowerCase())) suggestions.push(value);
  };
  const entityValues = entityColumn?.distinctValues?.filter(value =>
    questionTokens.some(token => normalizeIdentifierValue(value).includes(token))
  ) || [];
  if (metric && entityColumn && entityValues.length >= 2) {
    entityValues.slice(0, 2).forEach(value => add(`What is ${metric.name} for ${value}?`));
    add(`Compare ${metric.name} for ${entityValues[0]} and ${entityValues[1]}`);
  }
  if (metric && entityColumn) add(`Show ${metric.name} by ${entityColumn.name}`);
  if (metric && date) add(`Show ${metric.name} over ${date.name}`);
  if (metric) add(`Show the highest ${metric.name} in ${table.name}`);
  if (entityColumn) add(`Show ${table.name} grouped by ${entityColumn.name}`);
  if (numeric.length > 1) add(`Compare ${numeric[0].name} and ${numeric[1].name} in ${table.name}`);
  if (reason) add(`Show all records from ${table.name}`);
  return suggestions.slice(0, 5);
}

/**
 * Resilient multi-model Gemini caller.
 * If the primary model experiences high demand (503/429), it automatically
 * falls back to sibling fast models (gemini-3.6-flash, gemini-flash-latest, gemini-3.1-flash-lite).
 */
async function generateContentWithFallback(
  client: GoogleGenAI,
  params: {
    contents: any;
    config?: any;
    preferredModel?: string;
  }
): Promise<{ text?: string }> {
  const candidates = [
    params.preferredModel || config.geminiModel,
    'gemini-3.6-flash',
    'gemini-flash-latest',
    'gemini-3.1-flash-lite',
  ];
  const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));

  let lastError: any = null;
  for (const model of uniqueCandidates) {
    try {
      const response = await client.models.generateContent({
        model,
        contents: params.contents,
        config: params.config,
      });
      return response;
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.code || 0;
      const msg = err?.message || String(err);
      console.warn(`[Gemini Resilience] Model '${model}' failed (code: ${status}): ${msg.slice(0, 150)}. Trying next candidate...`);
      await new Promise(res => setTimeout(res, 250));
    }
  }
  throw lastError;
}

export async function understandQuestion(
  question: string,
  tables: TableMetadata[]
): Promise<QuestionInterpretation> {
  const client = getAiClient();
  const schemaStr = formatSchemaForPrompt(tables);
  const questionCheck = validateQuestion(question, tables);

  if (questionCheck.status === 'needs_clarification') {
    return normalizeInterpretation({
      status: 'needs_clarification',
      summary: questionCheck.reason || '',
      groupBy: [],
      filters: [],
      sort: [],
    }, question, tables);
  }

  if (!client) {
    // Fallback heuristic interpretation when GEMINI_API_KEY is not configured
    const lower = question.toLowerCase();
    const isAvg = lower.includes('avg') || lower.includes('average');
    const isSum = lower.includes('sum') || lower.includes('total');
    const isCount = lower.includes('count') || lower.includes('how many');

    let agg = isAvg ? 'AVG' : isSum ? 'SUM' : isCount ? 'COUNT' : null;
    let measure: string | null = null;
    const groupBy: string[] = [];

    for (const t of tables) {
      for (const col of t.columns) {
        if (lower.includes(col.name.toLowerCase())) {
          if (['BIGINT', 'NUMERIC', 'INTEGER'].includes(col.dataType) && !measure) {
            measure = col.name;
          } else if (!groupBy.includes(col.name)) {
            groupBy.push(col.name);
          }
        }
      }
    }

    return normalizeInterpretation({
      status: 'ready',
      summary: `Analyze ${agg || 'metrics'} ${measure ? 'of ' + measure : ''} ${groupBy.length ? 'grouped by ' + groupBy.join(', ') : ''}`.trim(),
      measure,
      aggregation: agg,
      groupBy,
      filters: [],
      sort: measure ? [{ field: measure, direction: 'desc' }] : [],
      requestedLimit: null,
    }, question, tables);
  }

  const prompt = `You are a transparent AI SQL Analyst.
Given the following database schema and user question, produce a structured interpretation.

Database Schema:
${schemaStr}

User Question: "${question}"

Classify the operation as SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, TRUNCATE, or UNKNOWN.
Analyze what data is needed. If the question is ambiguous, set status to 'needs_clarification' and provide clarificationQuestion.
If the database does not contain the required information at all, set status to 'unsupported'. Do not use 'out_of_scope' for a normal data question; let SQL validation determine whether the requested fields exist.
Otherwise, set status to 'ready'.`;

  const responseSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      status: {
        type: Type.STRING,
        enum: ['ready', 'needs_clarification', 'unsupported', 'out_of_scope'],
      },
      operation: { type: Type.STRING, enum: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'UNKNOWN'] },
      targetEntities: { type: Type.ARRAY, items: { type: Type.STRING } },
      metrics: { type: Type.ARRAY, items: { type: Type.STRING } },
      summary: {
        type: Type.STRING,
        description: 'Concise plain English summary of the intended data analysis.',
      },
      measure: {
        type: Type.STRING,
        nullable: true,
        description: 'The numeric column being measured or aggregated.',
      },
      aggregation: {
        type: Type.STRING,
        nullable: true,
        description: 'Aggregation function: AVG, SUM, COUNT, MIN, MAX, or null.',
      },
      groupBy: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Columns to group by.',
      },
      filters: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            field: { type: Type.STRING },
            op: { type: Type.STRING },
            val: { type: Type.STRING },
          },
          required: ['field', 'op', 'val'],
        },
      },
      sort: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            field: { type: Type.STRING },
            direction: { type: Type.STRING, enum: ['asc', 'desc'] },
          },
          required: ['field', 'direction'],
        },
      },
      requestedLimit: {
        type: Type.INTEGER,
        nullable: true,
      },
      clarificationQuestion: {
        type: Type.STRING,
        nullable: true,
      },
    },
    required: ['status', 'operation', 'targetEntities', 'metrics', 'summary', 'groupBy', 'filters', 'sort'],
  };

  try {
    const response = await generateContentWithFallback(client, {
      preferredModel: config.geminiModel,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema,
        temperature: 0.1,
      },
    });

    const parsed = JSON.parse(response.text || '{}') as Partial<QuestionInterpretation>;
    return normalizeInterpretation(parsed, question, tables);
  } catch (err) {
    console.warn('Gemini question interpretation fallback invoked:', err);
    return normalizeInterpretation({
      status: 'ready',
      summary: `Analyze data for: "${question}"`,
      groupBy: [],
      filters: [],
      sort: [],
      requestedLimit: null,
    }, question, tables);
  }
}

export async function generateSqlWithCorrection(
  question: string,
  interpretation: QuestionInterpretation,
  tables: TableMetadata[]
): Promise<{
  sql: string;
  report: ValidationReport;
  attempts: { attemptNumber: number; sql: string; report: ValidationReport; correctionReason?: string }[];
}> {
  const client = getAiClient();
  const schemaStr = formatSchemaForPrompt(tables);
  const attempts: { attemptNumber: number; sql: string; report: ValidationReport; correctionReason?: string }[] = [];

  let currentSql = '';
  let currentReport: ValidationReport | null = null;
  let lastErrors: string[] = [];

  if (interpretation.operation === 'SELECT' && (interpretation.filters.length > 0 || interpretation.sort.length > 0)) {
    currentSql = generateDeterministicSql(question, tables, interpretation);
    currentReport = validateSql(currentSql, tables, interpretation.operation);
    console.log('[NL->SQL] generatedSQL=%j validation=%j', currentSql, {
      isValid: currentReport.isValid,
      errors: currentReport.errors,
    });
    return {
      sql: currentSql,
      report: currentReport,
      attempts: [{ attemptNumber: 1, sql: currentSql, report: currentReport }],
    };
  }

  for (let attempt = 1; attempt <= config.maxSqlCorrections + 1; attempt++) {
    if (!client) {
      // Deterministic rule-based SQL generator for offline testing and baseline verification
      currentSql = generateDeterministicSql(question, tables, interpretation);
      currentReport = validateSql(currentSql, tables, interpretation.operation);
      attempts.push({
        attemptNumber: attempt,
        sql: currentSql,
        report: currentReport,
      });
      break;
    }

    const isCorrection = attempt > 1;
      const prompt = isCorrection
        ? `You are correcting a previous PostgreSQL statement that failed deterministic validation.
Database Schema:
${schemaStr}

User Question: "${question}"
Interpretation: ${interpretation.summary}
Structured intent (must be followed exactly):
${JSON.stringify({
  operation: interpretation.operation,
  targetEntities: interpretation.targetEntities,
  filters: interpretation.filters,
  sort: interpretation.sort,
  requestedLimit: interpretation.requestedLimit,
})}

Previous Attempt:
${currentSql}

Validation Errors from AST Validator:
${lastErrors.join('\n')}

Rules:
1. Return JSON with exactly sql, operation, and confidence fields. Do not return markdown or explanations.
2. Generate the requested operation (${interpretation.operation}); do not change it.
3. Only use real table and column names from the schema above.
4. Use proper joins if querying multiple tables.
5. For SELECT rankings or ordering of nullable aggregates, use NULLS LAST and LIMIT 1000.
6. Do not execute SQL.`
    : `You are an expert PostgreSQL analyst. Generate one PostgreSQL statement.
Database Schema:
${schemaStr}

User Question: "${question}"
Interpretation: ${interpretation.summary}
Structured intent (must be followed exactly):
${JSON.stringify({
  operation: interpretation.operation,
  targetEntities: interpretation.targetEntities,
  filters: interpretation.filters,
  sort: interpretation.sort,
  requestedLimit: interpretation.requestedLimit,
})}

Rules:
1. Return JSON with exactly sql, operation, and confidence fields. Do not return markdown or explanations.
2. Generate operation ${interpretation.operation}; preserve the user's requested meaning.
3. Only use real table and column names from the schema above.
4. For SELECT aggregates, group by all non-aggregate projected columns and include LIMIT 1000.
5. Do not execute SQL or return credentials.`;

    try {
      const response = await generateContentWithFallback(client, {
        preferredModel: config.geminiModel,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              sql: { type: Type.STRING },
              operation: { type: Type.STRING, enum: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'UNKNOWN'] },
              confidence: { type: Type.NUMBER },
            },
            required: ['sql', 'operation'],
          },
          temperature: 0.1,
        },
      });

      let rawSql = response.text || '';
      try {
        const candidate = JSON.parse(rawSql) as { sql?: string };
        rawSql = candidate.sql || '';
      } catch {
        rawSql = rawSql.replace(/```sql/gi, '').replace(/```/g, '').trim();
      }
      currentSql = normalizeGeneratedSql(rawSql, interpretation);

      // Validate SQL AST
      currentReport = validateSql(currentSql, tables, interpretation.operation);
      attempts.push({
        attemptNumber: attempt,
        sql: currentSql,
        report: currentReport,
        correctionReason: isCorrection ? `Corrected based on: ${lastErrors.join('; ')}` : undefined,
      });

      if (currentReport.isValid) {
        break;
      } else {
        lastErrors = currentReport.errors;
      }
    } catch (err: any) {
      console.error(`Gemini SQL generation attempt ${attempt} failed:`, err);
      currentSql = generateDeterministicSql(question, tables, interpretation);
      currentReport = validateSql(currentSql, tables, interpretation.operation);
      attempts.push({
        attemptNumber: attempt,
        sql: currentSql,
        report: currentReport,
        correctionReason: `Fallback due to API error: ${err.message}`,
      });
      break;
    }
  }

  return {
    sql: currentSql,
    report: currentReport!,
    attempts,
  };
}

export function generateDeterministicSql(
  question: string,
  tables: TableMetadata[],
  interpretationOrOperation: QuestionInterpretation | OperationType = 'SELECT',
): string {
  const interpretation: QuestionInterpretation = typeof interpretationOrOperation === 'string'
    ? {
        status: 'ready',
        validation: { status: 'valid' },
        operation: interpretationOrOperation,
        targetEntities: [],
        metrics: [],
        summary: question,
        groupBy: [],
        filters: [],
        sort: [],
        requestedLimit: null,
      }
    : interpretationOrOperation;
  const operation = interpretation.operation;
  if (tables.length === 0) {
    return operation === 'SELECT' ? 'SELECT 1' : `${operation} /* no active table */`;
  }

  const lower = question.toLowerCase();

  // Find students & departments tables if present
  const studentsTable = tables.find(t => t.name.toLowerCase() === 'students');
  const deptTable = tables.find(t => t.name.toLowerCase() === 'departments');
  const coursesTable = tables.find(t => t.name.toLowerCase() === 'courses');
  const attendanceTable = tables.find(t => t.name.toLowerCase() === 'attendance');

  // Case: Students count per department
  if (studentsTable && deptTable && (lower.includes('department') || lower.includes('dept')) && lower.includes('student')) {
    return `SELECT d.department_name, COUNT(s.student_id) AS student_count FROM "${deptTable.name}" d LEFT JOIN "${studentsTable.name}" s ON s.department_id = d.department_id GROUP BY d.department_name ORDER BY student_count DESC NULLS LAST LIMIT 1000`;
  }

  // Case: Attendance rate per course
  if (attendanceTable && coursesTable && (lower.includes('attendance') || lower.includes('present') || lower.includes('absent'))) {
    return `SELECT c.course_name, a.status, COUNT(*) AS status_count FROM "${attendanceTable.name}" a JOIN "${coursesTable.name}" c ON c.course_id = a.course_id GROUP BY c.course_name, a.status ORDER BY c.course_name, status_count DESC LIMIT 1000`;
  }

  // Find table whose name appears in question
  const matchingTable = tables.find(t => interpretation.targetEntities.includes(t.name))
    || tables.find(t => lower.includes(t.name.toLowerCase()))
    || tables[0];
  const colNames = matchingTable.columns.map(c => c.name);

  if (operation === 'DELETE') {
    return `DELETE FROM "${matchingTable.name}" WHERE TRUE`;
  }
  if (operation === 'UPDATE') {
    const numeric = matchingTable.columns.find(c => ['NUMERIC', 'INTEGER', 'BIGINT', 'DOUBLE PRECISION', 'REAL', 'DECIMAL'].includes(c.dataType) && !c.isPrimaryKey);
    if (numeric && /\b(increase|raise|add)\b/.test(lower)) {
      return `UPDATE "${matchingTable.name}" SET "${numeric.name}" = "${numeric.name}" * 1.10 WHERE TRUE`;
    }
    return `UPDATE "${matchingTable.name}" SET "${numeric?.name || colNames[0]}" = "${numeric?.name || colNames[0]}" WHERE TRUE`;
  }
  if (operation === 'INSERT') {
    const writable = matchingTable.columns.filter(c => !c.isPrimaryKey && c.isNullable);
    if (writable.length > 0) {
      return `INSERT INTO "${matchingTable.name}" ("${writable[0].name}") VALUES (NULL)`;
    }
    return `INSERT INTO "${matchingTable.name}" DEFAULT VALUES`;
  }
  if (operation === 'TRUNCATE') return `TRUNCATE TABLE "${matchingTable.name}"`;
  if (operation === 'DROP') return `DROP TABLE "${matchingTable.name}"`;
  if (operation === 'ALTER') return `ALTER TABLE "${matchingTable.name}" ADD COLUMN "new_column" TEXT`;
  if (operation === 'CREATE') return 'CREATE TABLE "new_table" ("id" INTEGER)';

  if (operation === 'SELECT' && interpretation.filters.length > 0) {
    const predicates = interpretation.filters.map(filter => {
      const column = matchingTable.columns.find(c => c.name.toLowerCase() === filter.field.toLowerCase());
      const field = column?.name || filter.field;
      const numeric = column && ['NUMERIC', 'INTEGER', 'BIGINT', 'DOUBLE PRECISION', 'REAL', 'DECIMAL'].includes(column.dataType);
      const value = numeric && /^-?\d+(?:\.\d+)?$/.test(filter.val)
        ? filter.val
        : `'${filter.val.replace(/'/g, "''")}'`;
      return `"${field}" ${filter.op} ${value}`;
    });
    const order = interpretation.sort.length
      ? ` ORDER BY "${interpretation.sort[0].field}" ${interpretation.sort[0].direction.toUpperCase()}`
      : '';
    const limit = interpretation.requestedLimit === null || interpretation.requestedLimit === undefined
      ? ''
      : ` LIMIT ${interpretation.requestedLimit}`;
    return `SELECT * FROM "${matchingTable.name}" WHERE ${predicates.join(' AND ')}${order}${limit}`;
  }

  // Check numeric columns for averages or sums
  const numCol = matchingTable.columns.find(c => ['NUMERIC', 'BIGINT', 'INTEGER', 'DOUBLE PRECISION'].includes(c.dataType) && !c.isPrimaryKey && !c.foreignKey);
  const textCol = matchingTable.columns.find(c => ['TEXT', 'VARCHAR'].includes(c.dataType));

  if (numCol && textCol && (lower.includes('avg') || lower.includes('average') || lower.includes('mean'))) {
    return `SELECT "${textCol.name}", ROUND(AVG("${numCol.name}"), 2) AS average_${numCol.name} FROM "${matchingTable.name}" GROUP BY "${textCol.name}" ORDER BY average_${numCol.name} DESC NULLS LAST LIMIT 1000`;
  }

  if (numCol && textCol && (lower.includes('sum') || lower.includes('total'))) {
    return `SELECT "${textCol.name}", SUM("${numCol.name}") AS total_${numCol.name} FROM "${matchingTable.name}" GROUP BY "${textCol.name}" ORDER BY total_${numCol.name} DESC NULLS LAST LIMIT 1000`;
  }

  if (textCol && (lower.includes('count') || lower.includes('how many'))) {
    return `SELECT "${textCol.name}", COUNT(*) AS total_count FROM "${matchingTable.name}" GROUP BY "${textCol.name}" ORDER BY total_count DESC LIMIT 1000`;
  }

  const order = interpretation.sort.length
    ? ` ORDER BY "${interpretation.sort[0].field}" ${interpretation.sort[0].direction.toUpperCase()}`
    : '';
  const limit = interpretation.requestedLimit === null || interpretation.requestedLimit === undefined
    ? ''
    : ` LIMIT ${interpretation.requestedLimit}`;
  return `SELECT * FROM "${matchingTable.name}"${order}${limit}`;
}

function normalizeGeneratedSql(
  sql: string,
  interpretation: QuestionInterpretation,
): string {
  let normalized = sql.trim();
  for (const filter of interpretation.filters) {
    if (!filter.resolvedValue || !filter.userValue) continue;
    const escapedField = filter.field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedUserValue = filter.userValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const valuePattern = new RegExp(
      `((?:"?${escapedField}"?)\\s*(?:=|<>|LIKE)\\s*')${escapedUserValue}(')`,
      'gi'
    );
    normalized = normalized.replace(
      valuePattern,
      (_match, prefix: string, suffix: string) => `${prefix}${filter.resolvedValue}${suffix}`
    );
  }
  if (interpretation.requestedLimit === null || interpretation.requestedLimit === undefined) {
    normalized = normalized.replace(/\s+LIMIT\s+\d+\s*;?\s*$/i, '');
  }
  return normalized;
}

export async function generateGroundedInsights(
  question: string,
  summary: string,
  columns: string[],
  sampleRows: Record<string, any>[]
): Promise<GroundedInsight> {
  const client = getAiClient();

  // Determine heuristic chart recommendation from data shape
  const chartRec = determineChartRecommendation(question, columns, sampleRows);

  if (!client || sampleRows.length === 0) {
    return {
      summary: `Analysis of ${sampleRows.length} records completed.`,
      explanation: `The query returned ${sampleRows.length} rows. Primary metrics observed across ${columns.join(', ')}.`,
      evidence: sampleRows.slice(0, 3).map(r => JSON.stringify(r)),
      chartRecommendation: chartRec,
    };
  }

  const prompt = `You are an AI data analyst.
Given the analytical question and the actual query results below, produce a strictly grounded, factual explanation.

Question: "${question}"
Interpretation: "${summary}"
Returned Columns: ${columns.join(', ')}
Returned Data (first ${sampleRows.length} rows):
${JSON.stringify(sampleRows.slice(0, 20), null, 2)}

Requirements:
1. Every claim, number, and difference must be directly verifiable in the data. Do NOT extrapolate or hallucinate unobserved data.
2. Highlight the key finding in the headline summary.
3. Detail 2-3 specific insights with numbers in the explanation.
4. List the exact verifiable data points in 'evidence'.
5. Recommend the best chart type (bar, line, donut, scatter, value_card, or table).`;

  const responseSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      summary: { type: Type.STRING },
      explanation: { type: Type.STRING },
      evidence: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      chartRecommendation: {
        type: Type.OBJECT,
        properties: {
          type: {
            type: Type.STRING,
            enum: ['bar', 'line', 'donut', 'scatter', 'value_card', 'table'],
          },
          xAxisKey: { type: Type.STRING },
          yAxisKey: { type: Type.STRING },
          seriesKey: { type: Type.STRING, nullable: true },
          title: { type: Type.STRING },
          reasoning: { type: Type.STRING },
        },
        required: ['type', 'title', 'reasoning'],
      },
    },
    required: ['summary', 'explanation', 'evidence', 'chartRecommendation'],
  };

  try {
    const response = await generateContentWithFallback(client, {
      preferredModel: config.geminiModel,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema,
        temperature: 0.1,
      },
    });

    const parsed = JSON.parse(response.text || '{}') as GroundedInsight;
    // Keep the visualization decision and data mapping deterministic and grounded.
    return {
      ...parsed,
      chartRecommendation: chartRec,
    };
  } catch (err) {
    console.error('Gemini insight generation failed:', err);
    return {
      summary: `Returned ${sampleRows.length} rows for question.`,
      explanation: `Query executed successfully returning ${sampleRows.length} rows.`,
      evidence: sampleRows.slice(0, 3).map(r => JSON.stringify(r)),
      chartRecommendation: chartRec,
    };
  }
}

function determineChartRecommendation(
  question: string,
  columns: string[],
  rows: Record<string, any>[]
): GroundedInsight['chartRecommendation'] {
  const tableOnly = (reasoning: string) => ({
    type: 'table' as const,
    visualizationNeeded: false,
    title: 'Data Table',
    reasoning,
  });
  if (rows.length === 0 || columns.length === 0) {
    return tableOnly('No data returned to plot.');
  }

  const normalizedQuestion = question.toLowerCase();
  const isListQuery = /\b(list|show|find|get|display)\b/.test(normalizedQuestion) &&
    !/\b(count|how many|average|avg|sum|total|distribution|compare|top|ranking|rank|trend|monthly|weekly|daily|over time|by)\b/.test(normalizedQuestion);
  if (isListQuery) {
    return tableOnly('This is a record-list query where a table is more useful.');
  }

  if (rows.length === 1 && columns.length === 1 && /\b(count|how many|average|avg|sum|total)\b/.test(normalizedQuestion)) {
    return {
      type: 'value_card',
      visualizationNeeded: true,
      title: columns[0],
      yAxisKey: columns[0],
      reasoning: 'Single scalar result is best displayed as a prominent value card.',
    };
  }

  // Find candidate numeric and categorical columns
  const numericCols: string[] = [];
  let categoryCol: string | undefined;
  let timeCol: string | undefined;

  for (const col of columns) {
    const values = rows.map(row => row[col]).filter(value => value !== null && value !== undefined);
    const firstValue = values[0];
    if (values.length > 0 && values.every(value => typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))))) {
      numericCols.push(col);
    } else if (typeof firstValue === 'string') {
      if (/date|time|day|month|year/i.test(col) || /^\d{4}-\d{2}/.test(firstValue)) {
        if (!timeCol) timeCol = col;
      } else {
        if (!categoryCol) categoryCol = col;
      }
    }
  }

  const numericCol = numericCols[0];
  const requestsTrend = /\b(trend|over time|monthly|weekly|daily|quarterly|yearly|by month|by week|by day)\b/.test(normalizedQuestion);
  const requestsDistribution = /\b(distribution|breakdown|share|proportion|composition)\b/.test(normalizedQuestion);
  const requestsComparison = /\b(compare|comparison|versus|vs\.?|by|top|ranking|rank|average|avg|count|how many|sum|total)\b/.test(normalizedQuestion);

  if (numericCols.length >= 2 && /\b(compare|relationship|correlation|versus|vs\.?)\b/.test(normalizedQuestion)) {
    return {
      type: 'scatter',
      visualizationNeeded: true,
      xAxisKey: numericCols[0],
      yAxisKey: numericCols[1],
      title: `${numericCols[1]} versus ${numericCols[0]}`,
      reasoning: 'Two numeric measures are compared at row level, so a scatter plot shows their relationship.',
    };
  }

  if (timeCol && numericCol && requestsTrend) {
    return {
      type: 'line',
      visualizationNeeded: true,
      xAxisKey: timeCol,
      yAxisKey: numericCol,
      title: `${numericCol} over ${timeCol}`,
      reasoning: 'Chronological time values with numeric measures are ideal for a line chart.',
    };
  }

  if (categoryCol && numericCol && (requestsComparison || requestsDistribution)) {
    if (requestsDistribution && rows.length <= 8 && rows.every(r => Number(r[numericCol!]) >= 0)) {
      return {
        type: 'donut',
        visualizationNeeded: true,
        xAxisKey: categoryCol,
        yAxisKey: numericCol,
        title: `${numericCol} distribution by ${categoryCol}`,
        reasoning: 'Small set of additive categories with non-negative values is well represented as a donut chart.',
      };
    }
    return {
      type: 'bar',
      visualizationNeeded: true,
      xAxisKey: categoryCol,
      yAxisKey: numericCol,
      title: `${numericCol} by ${categoryCol}`,
      reasoning: 'Categorical labels paired with numeric measures are best compared with a bar chart.',
    };
  }

  return tableOnly('The result does not contain a meaningful comparison, distribution, or trend.');
}

export async function geminiDocumentExtraction(
  text: string | null,
  filename: string,
  mimeType: string,
  filePath?: string
): Promise<{ tables: any[] } | null> {
  const client = getAiClient();
  if (!client) {
    throw new Error('Gemini API is not configured.');
  }

    const prompt = `Extract all tabular data from the following document into a structured JSON array.
If no tabular data exists, return an empty array [].
Respond ONLY with a JSON object matching this schema:
{
  "tables": [
    {
      "name": "Table Name",
      "columns": [
        {
          "originalName": "Column Header",
          "internalName": "column_header",
          "detectedType": "TEXT",
          "isNullable": true
        }

      ],
      "rows": [
        {
          "column_header": "value"
        }
      ],
      "issues": []
    }
  ]
}

Document Name: ${filename}
`;

  let contents: any[] = [{ text: prompt }];

  if (filePath && !text) {
    const fs = await import('fs');
    const buffer = await fs.promises.readFile(filePath);
    contents.push({
      inlineData: {
        data: buffer.toString('base64'),
        mimeType: mimeType === 'application/pdf' ? 'application/pdf' : mimeType,
      }
    });
  } else if (text) {
    contents.push({ text: `\n\n--- DOCUMENT CONTENT ---\n${text}` });
  }

  const response = await generateContentWithFallback(client, {
    preferredModel: config.geminiModel, // use the configured model, not a hardcoded invalid name
    contents: contents,
    config: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  });

  if (!response.text) {
    return null;
  }

  try {
    return JSON.parse(response.text);
  } catch (err) {
    throw new Error('Failed to parse AI extraction result as JSON.');
  }
}
