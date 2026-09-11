import { GoogleGenAI, Type, Schema } from '@google/genai';
import { config } from './config.ts';
import { TableMetadata } from './schema.ts';
import { validateSql, ValidationReport } from './validator.ts';
import { generateWithLLM, getCurrentProvider } from './llm-adapter.ts';

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
  status: 'ready' | 'needs_clarification' | 'unsupported';
  summary: string;
  measure?: string | null;
  aggregation?: string | null;
  groupBy: string[];
  filters: { field: string; op: string; val: string }[];
  sort: { field: string; direction: 'asc' | 'desc' }[];
  requestedLimit?: number | null;
  clarificationQuestion?: string | null;
}

export interface GroundedInsight {
  summary: string;
  explanation: string;
  evidence: string[];
  chartRecommendation: {
    type: 'bar' | 'line' | 'donut' | 'scatter' | 'value_card' | 'table';
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

    return {
      status: 'ready',
      summary: `Analyze ${agg || 'metrics'} ${measure ? 'of ' + measure : ''} ${groupBy.length ? 'grouped by ' + groupBy.join(', ') : ''}`.trim(),
      measure,
      aggregation: agg,
      groupBy,
      filters: [],
      sort: measure ? [{ field: measure, direction: 'desc' }] : [],
      requestedLimit: 1000,
    };
  }

  const prompt = `You are a transparent AI SQL Analyst.
Given the following database schema and user question, produce a structured interpretation.

Database Schema:
${schemaStr}

User Question: "${question}"

Analyze what data is needed. If the question is ambiguous, set status to 'needs_clarification' and provide clarificationQuestion.
If the database does not contain the required information at all, set status to 'unsupported'.
Otherwise, set status to 'ready'.`;

  const responseSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      status: {
        type: Type.STRING,
        enum: ['ready', 'needs_clarification', 'unsupported'],
      },
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
    required: ['status', 'summary', 'groupBy', 'filters', 'sort'],
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

    const parsed = JSON.parse(response.text || '{}') as QuestionInterpretation;
    return parsed;
  } catch (err) {
    console.warn('Gemini question interpretation fallback invoked:', err);
    return {
      status: 'ready',
      summary: `Analyze data for: "${question}"`,
      groupBy: [],
      filters: [],
      sort: [],
      requestedLimit: 1000,
    };
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

  for (let attempt = 1; attempt <= config.maxSqlCorrections + 1; attempt++) {
    if (!client) {
      // Deterministic rule-based SQL generator for offline testing and baseline verification
      currentSql = generateDeterministicSql(question, tables);
      currentReport = validateSql(currentSql, tables);
      attempts.push({
        attemptNumber: attempt,
        sql: currentSql,
        report: currentReport,
      });
      break;
    }

    const isCorrection = attempt > 1;
    const prompt = isCorrection
      ? `CRITICAL: You MUST output ONLY raw SQL. NO explanation, NO comments, NO markdown, NO extra text.

Database Schema:
${schemaStr}

User Question: "${question}"

Previous Query Failed:
${currentSql}

Errors:
${lastErrors.join('\n')}

OUTPUT ONLY A VALID POSTGRESQL SELECT QUERY. START WITH "SELECT" AND END WITH SEMICOLON.
DO NOT include any other text, explanation, or commentary.
DO NOT use markdown code blocks.
JUST THE SQL QUERY AND NOTHING ELSE.`
      : `You are a PostgreSQL expert. Generate a SQL query that answers the question.

Database Schema:
${schemaStr}

Question: "${question}"

INSTRUCTIONS:
1. Output ONLY a SELECT query
2. NO explanation, NO markdown, NO comments
3. Start with SELECT, end with ;
4. Use real table/column names from schema
5. For names like "diya patel": WHERE table.name ILIKE '%diya patel%'
6. For attendance: JOIN students with attendance table
7. Add LIMIT 1000

EXAMPLES FROM YOUR DATABASE:
- "i want attendance of diya patel" → SELECT * FROM attendance a JOIN students s ON a.student_id = s.student_id WHERE s.name ILIKE '%diya patel%' LIMIT 1000;
- "show rohan mehta" → SELECT * FROM students WHERE name ILIKE '%rohan mehta%' LIMIT 1000;
- "students from CS dept" → SELECT * FROM students WHERE department ILIKE '%CS%' LIMIT 1000;

OUTPUT ONLY THE SQL QUERY.`;

    try {
      // Try LLM provider first (Ollama, Together AI, etc.)
      const llmProvider = getCurrentProvider();
      let response = null;

      if (llmProvider && llmProvider !== 'gemini') {
        console.log(`[SQL Generation] Using ${llmProvider} via LLM adapter`);
        response = await generateWithLLM(prompt, 0.1);
      } else if (client) {
        // Fallback to Gemini if LLM not available
        console.log('[SQL Generation] Using Gemini API');
        response = await generateContentWithFallback(client, {
          preferredModel: config.geminiModel,
          contents: prompt,
          config: {
            temperature: 0.1,
          },
        });
      }

      if (!response) {
        throw new Error('No LLM provider available');
      }

      let rawSql = response.text || '';
      
      // Aggressive cleaning: remove ALL non-SQL text
      // Remove markdown code blocks
      rawSql = rawSql.replace(/```sql/gi, '').replace(/```/g, '');
      
      // Remove common explanation patterns
      rawSql = rawSql.replace(/^.*?(?=SELECT)/is, ''); // Remove everything before SELECT
      rawSql = rawSql.replace(/;.*$/is, ';'); // Keep only up to first semicolon
      
      // Remove common prefixes
      rawSql = rawSql.replace(/^(Here is|Here's|This is|The query|Query:|SQL:|Here you go|Based on)[^:]*:?\s*/i, '');
      
      // Remove common explanations at end
      rawSql = rawSql.replace(/\n\n.*$/s, '');
      
      // Trim whitespace
      rawSql = rawSql.trim();
      
      // Ensure it ends with semicolon
      if (!rawSql.endsWith(';')) {
        rawSql += ';';
      }
      
      currentSql = rawSql;

      // Validate SQL AST
      currentReport = validateSql(currentSql, tables);
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
      console.error(`LLM SQL generation attempt ${attempt} failed:`, err);
      currentSql = generateDeterministicSql(question, tables);
      currentReport = validateSql(currentSql, tables);
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

function generateDeterministicSql(question: string, tables: TableMetadata[]): string {
  if (tables.length === 0) {
    return 'SELECT 1;';
  }

  const lower = question.toLowerCase();

  // ============================================================
  // SPECIAL CASE: User asking about TABLES/SCHEMA (not data query)
  // ============================================================
  if ((lower.includes('table') || lower.includes('schema') || lower.includes('structure')) && 
      !lower.includes('where') && !lower.includes('filter') && !lower.includes('show me') &&
      !lower.includes('attendance') && !lower.includes('student') && !lower.includes('of')) {
    // Return a query that shows table information
    const tableList = tables.map(t => `'${t.name}'`).join(', ');
    return `SELECT table_name FROM information_schema.tables WHERE table_name IN (${tableList}) LIMIT 1000;`;
  }

  // ============================================================
  // PRIORITY 1: CHECK FOR NAME/VALUE FILTERS FIRST
  // This must come BEFORE generic pattern matching
  // ============================================================
  
  // Extract potential names/values from question (for filtering)
  let filterValue: string | null = null;
  let filterColumn: string | null = null;
  
  // Try to find quoted values: "diya patel" or 'diya patel'
  const quotedMatch = question.match(/["']([^"']+)["']/);
  if (quotedMatch) {
    filterValue = quotedMatch[1];
  } else {
    // Look for capitalized words (likely names) if no quotes
    const capitalMatch = question.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/);
    if (capitalMatch) {
      filterValue = capitalMatch[1];
    }
  }
  
  // Find the primary table to query (attendance, students, etc.)
  let primaryTable = tables.find(t => lower.includes(t.name.toLowerCase())) || tables[0];
  
  // If looking for a name filter, find the table with a name column
  if (filterValue) {
    // First try: look for students table (likely has name column)
    const studentsTable = tables.find(t => t.name.toLowerCase() === 'students');
    if (studentsTable && studentsTable.columns.some(c => c.name.toLowerCase().includes('name'))) {
      primaryTable = studentsTable;
    }
  }
  
  // Try to find a text column for filtering (name, student_name, employee_name, etc.)
  let nameColumn: string | null = null;
  if (filterValue) {
    const nameColumns = primaryTable.columns.filter(c => 
      ['TEXT', 'VARCHAR'].includes(c.dataType) && 
      c.name.toLowerCase().includes('name')
    );
    if (nameColumns.length > 0) {
      nameColumn = nameColumns[0].name;
      // FOUND A NAME FILTER - RETURN IMMEDIATELY with filtered query
      const whereClause = `WHERE "${primaryTable.name}"."${nameColumn}" ILIKE '%${filterValue.replace(/'/g, "''")}%'`;
      return `SELECT * FROM "${primaryTable.name}" ${whereClause} LIMIT 1000;`;
    }
  }

  // ============================================================
  // PRIORITY 2: ATTENDANCE QUERIES (with smart joins)
  // ============================================================
  
  const attendanceTable = tables.find(t => t.name.toLowerCase() === 'attendance');
  const studentsTable = tables.find(t => t.name.toLowerCase() === 'students');
  const coursesTable = tables.find(t => t.name.toLowerCase() === 'courses');
  
  // If asking for attendance, join with students and courses
  if (attendanceTable && studentsTable && coursesTable && lower.includes('attendance')) {
    return `SELECT a.attendance_id, s.name, c.title, a.date, a.status FROM "${attendanceTable.name}" a JOIN "${studentsTable.name}" s ON a.student_id = s.student_id JOIN "${coursesTable.name}" c ON a.course_id = c.course_id LIMIT 1000;`;
  }

  // ============================================================
  // PRIORITY 3: GENERIC PATTERNS
  // ============================================================
  
  const deptTable = tables.find(t => t.name.toLowerCase() === 'departments');
  
  // Case: Students count per department
  if (studentsTable && deptTable && (lower.includes('department') || lower.includes('dept')) && lower.includes('student')) {
    return `SELECT d.department_name, COUNT(s.student_id) AS student_count FROM "${deptTable.name}" d LEFT JOIN "${studentsTable.name}" s ON s.department_id = d.department_id GROUP BY d.department_name ORDER BY student_count DESC NULLS LAST LIMIT 1000;`;
  }

  const numCol = primaryTable.columns.find(c => ['NUMERIC', 'BIGINT', 'INTEGER', 'DOUBLE PRECISION'].includes(c.dataType) && !c.isPrimaryKey && !c.foreignKey);
  const textCol = primaryTable.columns.find(c => ['TEXT', 'VARCHAR'].includes(c.dataType));

  if (numCol && textCol && (lower.includes('avg') || lower.includes('average') || lower.includes('mean'))) {
    return `SELECT "${textCol.name}", ROUND(AVG("${numCol.name}"), 2) AS average_${numCol.name} FROM "${primaryTable.name}" GROUP BY "${textCol.name}" ORDER BY average_${numCol.name} DESC NULLS LAST LIMIT 1000;`;
  }

  if (numCol && textCol && (lower.includes('sum') || lower.includes('total'))) {
    return `SELECT "${textCol.name}", SUM("${numCol.name}") AS total_${numCol.name} FROM "${primaryTable.name}" GROUP BY "${textCol.name}" ORDER BY total_${numCol.name} DESC NULLS LAST LIMIT 1000;`;
  }

  if (textCol && (lower.includes('count') || lower.includes('how many'))) {
    return `SELECT "${textCol.name}", COUNT(*) AS total_count FROM "${primaryTable.name}" GROUP BY "${textCol.name}" ORDER BY total_count DESC LIMIT 1000;`;
  }

  return `SELECT * FROM "${primaryTable.name}" LIMIT 1000;`;
}

export async function generateGroundedInsights(
  question: string,
  summary: string,
  columns: string[],
  sampleRows: Record<string, any>[]
): Promise<GroundedInsight> {
  const client = getAiClient();

  // Determine heuristic chart recommendation from data shape
  const chartRec = determineChartRecommendation(columns, sampleRows);

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
    // Guarantee chart keys exist
    if (!parsed.chartRecommendation.xAxisKey && chartRec.xAxisKey) {
      parsed.chartRecommendation.xAxisKey = chartRec.xAxisKey;
    }
    if (!parsed.chartRecommendation.yAxisKey && chartRec.yAxisKey) {
      parsed.chartRecommendation.yAxisKey = chartRec.yAxisKey;
    }
    return parsed;
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
  columns: string[],
  rows: Record<string, any>[]
): GroundedInsight['chartRecommendation'] {
  if (rows.length === 0 || columns.length === 0) {
    return { type: 'table', title: 'Data Table', reasoning: 'No data returned to plot.' };
  }

  if (rows.length === 1 && columns.length === 1) {
    return {
      type: 'value_card',
      title: columns[0],
      yAxisKey: columns[0],
      reasoning: 'Single scalar result is best displayed as a prominent value card.',
    };
  }

  // Find candidate numeric and categorical columns
  let numericCol: string | undefined;
  let categoryCol: string | undefined;
  let timeCol: string | undefined;

  const firstRow = rows[0];
  for (const col of columns) {
    const val = firstRow[col];
    if (typeof val === 'number') {
      if (!numericCol) numericCol = col;
    } else if (typeof val === 'string') {
      if (/date|time|day|month|year/i.test(col) || /^\d{4}-\d{2}/.test(val)) {
        if (!timeCol) timeCol = col;
      } else {
        if (!categoryCol) categoryCol = col;
      }
    }
  }

  if (timeCol && numericCol) {
    return {
      type: 'line',
      xAxisKey: timeCol,
      yAxisKey: numericCol,
      title: `${numericCol} over ${timeCol}`,
      reasoning: 'Chronological time values with numeric measures are ideal for a line chart.',
    };
  }

  if (categoryCol && numericCol) {
    if (rows.length <= 6 && rows.every(r => typeof r[numericCol!] === 'number' && r[numericCol!] >= 0)) {
      return {
        type: 'donut',
        xAxisKey: categoryCol,
        yAxisKey: numericCol,
        title: `${numericCol} distribution by ${categoryCol}`,
        reasoning: 'Small set of additive categories with non-negative values is well represented as a donut chart.',
      };
    }
    return {
      type: 'bar',
      xAxisKey: categoryCol,
      yAxisKey: numericCol,
      title: `${numericCol} by ${categoryCol}`,
      reasoning: 'Categorical labels paired with numeric measures are best compared with a bar chart.',
    };
  }

  return {
    type: 'table',
    title: 'Data View',
    reasoning: 'Multi-column dataset without clear metric pairing is best viewed as a tabular grid.',
  };
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
    preferredModel: 'gemini-3.8-flash',
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
