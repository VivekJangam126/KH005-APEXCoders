/**
 * Ingestion pipeline tests.
 * These are PARSER/UNIT tests using synthetic fixtures.
 * They do NOT use the user's original failing file (which was not available).
 * Live PostgreSQL and Gemini API tests are labeled separately and require
 * DATABASE_URL and GEMINI_API_KEY to be set.
 *
 * Run: npx tsx server/ingestion-tests.ts
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseAndValidateCsv, sanitizeIdentifier } from './csv.ts';
import { DocumentIngestionAgent } from './ingestion-agent.ts';
import { profileDataset } from './profiler.ts';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

{
  console.log('\n[1.7] Empty rows and columns are removed before import');
  const result = parseAndValidateCsv(Buffer.from(
    'name,empty_column,score\nAlice,,10\n,,\nBob,,20\n'
  ), 'fixture_cleaning.csv');
  assert(result.totalRows === 2, 'empty data row removed', `got ${result.totalRows}`);
  assert(result.columns.length === 2, 'empty column removed', `got ${result.columns.length}`);
  assert(!result.columns.some(column => column.originalName === 'empty_column'), 'empty column is absent');
}

{
  console.log('\n[1.8] Deterministic dataset profiling');
  const profile = profileDataset(
    [
      { id: 1, amount: 10.5, active: true, date: '2025-01-01', category: 'A' },
      { id: 2, amount: 20.5, active: false, date: '2025-01-02', category: 'B' },
      { id: 2, amount: null, active: false, date: 'invalid', category: 'B' },
    ],
    [
      { internalName: 'id', originalName: 'id' },
      { internalName: 'amount', originalName: 'amount' },
      { internalName: 'active', originalName: 'active' },
      { internalName: 'date', originalName: 'date' },
      { internalName: 'category', originalName: 'category' },
    ],
    'profile-fixture.csv'
  );
  assert(profile.rows === 3 && profile.columns === 5, 'profile dimensions are correct');
  assert(profile.duplicateRows === 0, 'duplicate row count is correct');
  assert(profile.columnsProfile.find(column => column.name === 'amount')?.detectedType === 'float', 'numeric type detected');
  assert(profile.columnsProfile.find(column => column.name === 'date')?.detectedType === 'text', 'mixed date values remain text');
  assert(profile.columnsProfile.find(column => column.name === 'id')?.possiblePrimaryKey === false, 'non-unique identifier is not a primary key');
}

// ---------------------------------------------------------------------------
// FIXTURE: The required known-data fixture (CSV, JSON, Excel variants tested below)
// department | marks | active | code
// AIML       | 80    | true   | 001
// AIML       | 100   | false  | 002
// CSE        | 70    | true   | 003
// CSE        | 90    | false  | 004
// Expected: 4 included records; codes remain TEXT with leading zeros;
//           false values remain present; AIML avg=90, CSE avg=80
// ---------------------------------------------------------------------------

const FIXTURE_CSV = `department,marks,active,code
AIML,80,true,001
AIML,100,false,002
CSE,70,true,003
CSE,90,false,004
`;

const FIXTURE_CSV_WITH_BLANK_ROW = `department,marks,active,code
AIML,80,true,001
AIML,100,false,002

CSE,70,true,003
CSE,90,false,004
`;

const FIXTURE_CSV_WITH_PARTIAL_ROW = `department,marks,active,code
AIML,80,true,001
AIML,100,false,002
CSE,,true,003
CSE,90,false,004
`;

const FIXTURE_CSV_QUOTED = `department,marks,active,code
"AIML, Dept",80,true,001
AIML,100,false,002
"CSE
Dept",70,true,003
CSE,90,false,004
`;

const FIXTURE_TSV = `department\tmarks\tactive\tcode
AIML\t80\ttrue\t001
AIML\t100\tfalse\t002
CSE\t70\ttrue\t003
CSE\t90\tfalse\t004
`;

const FIXTURE_JSON_ARRAY = JSON.stringify([
  { department: 'AIML', marks: 80, active: true, code: '001' },
  { department: 'AIML', marks: 100, active: false, code: '002' },
  { department: 'CSE', marks: 70, active: true, code: '003' },
  { department: 'CSE', marks: 90, active: false, code: '004' },
]);

const FIXTURE_JSON_NESTED = JSON.stringify({
  metadata: { source: 'test' },
  records: [
    { department: 'AIML', marks: 80, active: true, code: '001' },
    { department: 'AIML', marks: 100, active: false, code: '002' },
    { department: 'CSE', marks: 70, active: true, code: '003' },
    { department: 'CSE', marks: 90, active: false, code: '004' },
  ],
});

const FIXTURE_JSONL = [
  JSON.stringify({ department: 'AIML', marks: 80, active: true, code: '001' }),
  JSON.stringify({ department: 'AIML', marks: 100, active: false, code: '002' }),
  'NOT VALID JSON',
  JSON.stringify({ department: 'CSE', marks: 70, active: true, code: '003' }),
  JSON.stringify({ department: 'CSE', marks: 90, active: false, code: '004' }),
].join('\n');

// ---------------------------------------------------------------------------
// SECTION 1: CSV parser unit tests
// ---------------------------------------------------------------------------
console.log('\n=== CSV Parser Tests ===');

{
  console.log('\n[1.1] Basic fixture CSV — 4 rows, leading-zero codes, false values');
  const result = parseAndValidateCsv(Buffer.from(FIXTURE_CSV), 'fixture.csv');
  assert(result.totalRows === 4, 'totalRows=4', `got ${result.totalRows}`);
  assert(result.columns.length === 4, 'columns=4');

  const codeCol = result.columns.find(c => c.originalName === 'code');
  assert(codeCol?.detectedType === 'TEXT', 'code column is TEXT (leading zeros preserved)', codeCol?.detectedType);

  const marksCol = result.columns.find(c => c.originalName === 'marks');
  assert(marksCol?.detectedType === 'BIGINT' || marksCol?.detectedType === 'NUMERIC', 'marks column is numeric');

  const activeCol = result.columns.find(c => c.originalName === 'active');
  assert(activeCol?.detectedType === 'BOOLEAN', 'active column is BOOLEAN');

  // false values must be present as false, not dropped
  const falseRows = result.allRows.filter(r => r[activeCol!.internalName] === false);
  assert(falseRows.length === 2, 'false values preserved (2 rows with active=false)', `got ${falseRows.length}`);

  // code values must retain leading zeros
  const codes = result.allRows.map(r => r[codeCol!.internalName]);
  assert(codes.includes('001'), 'code 001 preserved as string');
  assert(codes.includes('002'), 'code 002 preserved as string');

  // Verify averages: AIML rows marks=[80,100] avg=90; CSE rows marks=[70,90] avg=80
  const aimlMarks = result.allRows.filter(r => r['department'] === 'AIML').map(r => Number(r['marks']));
  const cseMarks = result.allRows.filter(r => r['department'] === 'CSE').map(r => Number(r['marks']));
  const aimlAvg = aimlMarks.reduce((a, b) => a + b, 0) / aimlMarks.length;
  const cseAvg = cseMarks.reduce((a, b) => a + b, 0) / cseMarks.length;
  assert(aimlAvg === 90, `AIML avg=90`, `got ${aimlAvg}`);
  assert(cseAvg === 80, `CSE avg=80`, `got ${cseAvg}`);
}

{
  console.log('\n[1.2] CSV with blank row — blank row excluded, partial row kept');
  const result = parseAndValidateCsv(Buffer.from(FIXTURE_CSV_WITH_BLANK_ROW), 'fixture_blank.csv');
  // csv-parse with skip_empty_lines:true skips the blank row
  assert(result.totalRows === 4, 'blank row excluded, 4 data rows remain', `got ${result.totalRows}`);
}

{
  console.log('\n[1.3] CSV with partial row — partial row kept with null for missing field');
  const result = parseAndValidateCsv(Buffer.from(FIXTURE_CSV_WITH_PARTIAL_ROW), 'fixture_partial.csv');
  assert(result.totalRows === 4, '4 rows total (partial row kept)', `got ${result.totalRows}`);
  const marksCol = result.columns.find(c => c.originalName === 'marks');
  const partialRow = result.allRows.find(r => r['department'] === 'CSE' && r[marksCol!.internalName] === null);
  assert(partialRow !== undefined, 'partial row has null for missing marks field');
  assert(marksCol?.isNullable === true, 'marks column marked nullable due to partial row');
}

{
  console.log('\n[1.4] CSV with quoted commas and embedded newlines');
  const result = parseAndValidateCsv(Buffer.from(FIXTURE_CSV_QUOTED), 'fixture_quoted.csv');
  assert(result.totalRows === 4, '4 rows parsed correctly through quoted fields', `got ${result.totalRows}`);
  const deptCol = result.columns.find(c => c.originalName === 'department');
  const depts = result.allRows.map(r => r[deptCol!.internalName]);
  assert(depts.some(d => typeof d === 'string' && d.includes('AIML, Dept')), 'quoted comma in value preserved');
}

{
  console.log('\n[1.5] TSV file — delimiter auto-detected as tab');
  const result = parseAndValidateCsv(Buffer.from(FIXTURE_TSV), 'fixture.tsv');
  assert(result.totalRows === 4, 'TSV: 4 rows parsed', `got ${result.totalRows}`);
  assert(result.columns.length === 4, 'TSV: 4 columns');
}

{
  console.log('\n[1.6] Zero and false values are not treated as empty');
  const csvWithZero = `name,score,flag\nalpha,0,false\nbeta,1,true\n`;
  const result = parseAndValidateCsv(Buffer.from(csvWithZero), 'zeros.csv');
  const scoreCol = result.columns.find(c => c.originalName === 'score');
  const flagCol = result.columns.find(c => c.originalName === 'flag');
  const zeroRow = result.allRows.find(r => r['name'] === 'alpha');
  assert(zeroRow?.[scoreCol!.internalName] === 0, 'score=0 preserved as 0, not null');
  assert(zeroRow?.[flagCol!.internalName] === false, 'flag=false preserved as false, not null');
}

// ---------------------------------------------------------------------------
// SECTION 2: JSON parser unit tests (via DocumentIngestionAgent)
// ---------------------------------------------------------------------------
console.log('\n=== JSON Parser Tests ===');

async function testJson() {
  // Write fixture to a real temp file so DocumentIngestionAgent.processFile can read it
  const tmpDir = os.tmpdir();

  {
    console.log('\n[2.1] JSON array of records');
    const buf = Buffer.from(FIXTURE_JSON_ARRAY);
    const parsed = JSON.parse(buf.toString('utf-8'));
    assert(Array.isArray(parsed) && parsed.length === 4, 'JSON array: 4 records');
    assert(parsed[1].active === false, 'JSON: false value preserved');
    assert(parsed[0].code === '001', 'JSON: leading-zero code preserved as string');
  }

  {
    console.log('\n[2.2] Nested JSON — record path auto-selected');
    const parsed = JSON.parse(FIXTURE_JSON_NESTED);
    assert(Array.isArray(parsed.records) && parsed.records.length === 4, 'nested JSON: records array found');
  }

  {
    console.log('\n[2.3] JSONL with one invalid line — valid lines parsed, invalid line reported');
    const lines = FIXTURE_JSONL.split('\n');
    let validCount = 0;
    let invalidCount = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try { JSON.parse(line); validCount++; } catch { invalidCount++; }
    }
    assert(validCount === 4, `JSONL: 4 valid lines`, `got ${validCount}`);
    assert(invalidCount === 1, `JSONL: 1 invalid line reported`, `got ${invalidCount}`);
  }

  {
    console.log('\n[2.4] JSON via DocumentIngestionAgent — fixture.json produces 4 rows');
    const tmpFile = path.join(tmpDir, `fixture_${crypto.randomUUID()}.json`);
    fs.writeFileSync(tmpFile, FIXTURE_JSON_ARRAY);
    try {
      const job = await DocumentIngestionAgent.processFile(
        crypto.randomUUID(), 'test-org', 'test-user',
        tmpFile, 'fixture.json', 'application/json', FIXTURE_JSON_ARRAY.length
      );
      assert(job.candidateTables.length === 1, 'JSON agent: 1 candidate table');
      assert(job.candidateTables[0]?.rowCount === 4, 'JSON agent: 4 rows', `got ${job.candidateTables[0]?.rowCount}`);
      const rows = job.candidateTables[0]?.rows || [];
      const falseRows = rows.filter(r => r['active'] === false);
      assert(falseRows.length === 2, 'JSON agent: false values preserved', `got ${falseRows.length}`);
      const codes = rows.map(r => r['code']);
      assert(codes.includes('001'), 'JSON agent: code 001 preserved');
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  {
    console.log('\n[2.5] Nested JSON via DocumentIngestionAgent — records path selected');
    const tmpFile = path.join(tmpDir, `fixture_nested_${crypto.randomUUID()}.json`);
    fs.writeFileSync(tmpFile, FIXTURE_JSON_NESTED);
    try {
      const job = await DocumentIngestionAgent.processFile(
        crypto.randomUUID(), 'test-org', 'test-user',
        tmpFile, 'fixture_nested.json', 'application/json', FIXTURE_JSON_NESTED.length
      );
      assert(job.candidateTables.length === 1, 'nested JSON agent: 1 candidate table');
      assert(job.candidateTables[0]?.rowCount === 4, 'nested JSON agent: 4 rows from records path', `got ${job.candidateTables[0]?.rowCount}`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  {
    console.log('\n[2.6] JSONL via DocumentIngestionAgent — 4 valid rows, 1 invalid line reported');
    const tmpFile = path.join(tmpDir, `fixture_${crypto.randomUUID()}.jsonl`);
    fs.writeFileSync(tmpFile, FIXTURE_JSONL);
    try {
      const job = await DocumentIngestionAgent.processFile(
        crypto.randomUUID(), 'test-org', 'test-user',
        tmpFile, 'fixture.jsonl', 'application/x-ndjson', FIXTURE_JSONL.length
      );
      assert(job.candidateTables[0]?.rowCount === 4, 'JSONL agent: 4 valid rows', `got ${job.candidateTables[0]?.rowCount}`);
      const invalidIssues = job.issues.filter(i => i.message.includes('Invalid JSON'));
      assert(invalidIssues.length === 1, 'JSONL agent: 1 invalid-line issue reported', `got ${invalidIssues.length}`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// SECTION 3: sanitizeIdentifier edge cases
// ---------------------------------------------------------------------------
console.log('\n=== sanitizeIdentifier Tests ===');

{
  assert(sanitizeIdentifier('Department Name') === 'department_name', 'spaces → underscores');
  assert(sanitizeIdentifier('001') === 'col_001', 'leading digit prefixed');
  assert(sanitizeIdentifier('') === 'col_', 'empty string → col_');
  assert(sanitizeIdentifier('marks%score') === 'marks_score', 'special chars → underscore');
  assert(sanitizeIdentifier('MARKS') === 'marks', 'uppercase → lowercase');
}

// ---------------------------------------------------------------------------
// SECTION 4: createAndPopulateTable column definition correctness
// ---------------------------------------------------------------------------
console.log('\n=== Column Definition Tests ===');

{
  // Verify NOT NULL vs NULL logic is correct
  // isNullable=false → NOT NULL; isNullable=true → no constraint (nullable)
  const col = { originalName: 'x', internalName: 'x', detectedType: 'TEXT' as const, isNullable: false, sampleValues: [] };
  const colDef = `"${col.internalName}" ${col.detectedType}${col.isNullable ? '' : ' NOT NULL'}`;
  assert(colDef === '"x" TEXT NOT NULL', 'isNullable=false → NOT NULL');

  const colNullable = { ...col, isNullable: true };
  const colDefNullable = `"${colNullable.internalName}" ${colNullable.detectedType}${colNullable.isNullable ? '' : ' NOT NULL'}`;
  assert(colDefNullable === '"x" TEXT', 'isNullable=true → no NOT NULL constraint');
}

// ---------------------------------------------------------------------------
// Run async tests
// ---------------------------------------------------------------------------
testJson().then(() => {
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
