import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as xlsx from 'xlsx';
import mammoth from 'mammoth';
import { parseAndValidateCsv, sanitizeIdentifier } from './csv.ts';
import { geminiDocumentExtraction } from './gemini.ts';
import { config } from './config.ts';
import { DatasetProfile, profileDataset } from './profiler.ts';

export type IngestionOutcome =
  | 'READY_FOR_REVIEW'
  | 'NEEDS_REVIEW'
  | 'NOT_TABULAR'
  | 'INVALID_FILE'
  | 'UNSUPPORTED_FORMAT'
  | 'PROCESSING_FAILED';

export interface IngestionJob {
  jobId: string;
  organizationId: string;
  createdBy: string;
  sourceFileName: string;
  sourceFileType: string;
  sourceFileSize: number;
  sourceHash: string;
  format: string;
  parserVersion: string;
  extractionStatus: IngestionOutcome;
  sourceCoverage: any;
  candidateTables: CandidateTable[];
  selectedTables: string[]; // IDs or names
  columnMappings: Record<string, any>;
  inferredTypes: Record<string, any>;
  totalRowsPerTable: Record<string, number>;
  issues: Issue[];
  profile?: DatasetProfile;
  transformations: any[];
  sourceReferences: Record<string, any>;
  proposedRelationships: any[];
  planRevision: number;
  planHash: string;
  expiresAt: string;
  confirmedAt?: string;
  createdDatabaseId?: string;
  lifecycleStatus: 'staged' | 'confirmed' | 'canceled' | 'expired';
  rawFilePath?: string;
}

export interface CandidateTable {
  id: string;
  name: string;
  columns: {
    originalName: string;
    internalName: string;
    detectedType: string;
    isNullable: boolean;
  }[];
  rows: Record<string, any>[];
  rowCount: number;
  issues: Issue[];
  profile?: DatasetProfile;
  semanticAnalysis?: {
    status: 'available' | 'unavailable';
    columns: { name: string; semanticName?: string; description?: string; role?: string; confidence?: number }[];
    relationships: unknown[];
    warnings: string[];
  };
}

export interface Issue {
  tableId?: string;
  row?: number;
  column?: string;
  message: string;
  severity: 'warning' | 'error';
}

function formatExtractionError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  let providerError: any = null;

  try {
    providerError = JSON.parse(rawMessage);
  } catch {
    providerError = null;
  }

  const providerMessage = providerError?.error?.message || providerError?.message;
  const providerCode = providerError?.error?.code || providerError?.code;
  const providerStatus = providerError?.error?.status || providerError?.status;

  if (providerCode === 401 || providerStatus === 'UNAUTHENTICATED' ||
      providerError?.error?.details?.some((detail: any) => detail?.reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED')) {
    return 'AI document extraction could not authenticate. Please verify the Gemini API key configuration and try again.';
  }

  if (providerMessage) {
    return `AI document extraction failed: ${providerMessage}`;
  }

  return rawMessage || 'Unknown document extraction error.';
}

export class DocumentIngestionAgent {
  static supportedFormats = [
    { format: 'Delimited tables', extensions: ['.csv', '.tsv'] },
    { format: 'Excel workbooks', extensions: ['.xlsx', '.xls'] },
    { format: 'Structured JSON', extensions: ['.json'] },
    { format: 'Line-delimited JSON', extensions: ['.jsonl', '.ndjson'] },
    { format: 'Text/Markdown', extensions: ['.txt', '.md'] },
    { format: 'PDF', extensions: ['.pdf'] },
    { format: 'Word document', extensions: ['.docx'] },
    { format: 'Scanned images', extensions: ['.png', '.jpg', '.jpeg', '.webp'] },
  ];

  static async processFile(
    jobId: string,
    organizationId: string,
    createdBy: string,
    filePath: string,
    originalFilename: string,
    mimeType: string,
    fileSize: number
  ): Promise<IngestionJob> {
    const ext = path.extname(originalFilename).toLowerCase();
    const buffer = await fs.promises.readFile(filePath);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    const job: IngestionJob = {
      jobId,
      organizationId,
      createdBy,
      sourceFileName: originalFilename,
      sourceFileType: mimeType,
      sourceFileSize: fileSize,
      sourceHash: hash,
      format: ext || 'unknown',
      parserVersion: '1.0',
      extractionStatus: 'PROCESSING_FAILED',
      sourceCoverage: {},
      candidateTables: [],
      selectedTables: [],
      columnMappings: {},
      inferredTypes: {},
      totalRowsPerTable: {},
      issues: [],
      transformations: [],
      sourceReferences: {},
      proposedRelationships: [],
      planRevision: 1,
      planHash: '',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      lifecycleStatus: 'staged',
      rawFilePath: filePath,
    };

    try {
      if (['.csv', '.tsv'].includes(ext)) {
        await this.processDelimited(buffer, originalFilename, job);
      } else if (['.xlsx', '.xls'].includes(ext)) {
        await this.processExcel(buffer, job);
      } else if (['.json'].includes(ext)) {
        await this.processJson(buffer, job);
      } else if (['.jsonl', '.ndjson'].includes(ext)) {
        await this.processJsonl(buffer, job);
      } else if (['.txt', '.md'].includes(ext)) {
        await this.processText(buffer, originalFilename, mimeType, job);
      } else if (['.pdf'].includes(ext)) {
        await this.processDocumentAI(filePath, originalFilename, mimeType, job);
      } else if (['.docx'].includes(ext)) {
        await this.processDocx(buffer, job);
      } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        await this.processDocumentAI(filePath, originalFilename, mimeType, job);
      } else {
        job.extractionStatus = 'UNSUPPORTED_FORMAT';
        job.issues.push({ message: `Format ${ext} is not supported.`, severity: 'error' });
      }

      job.planHash = crypto.createHash('sha256').update(JSON.stringify(job.candidateTables)).digest('hex');

      if (job.extractionStatus !== 'UNSUPPORTED_FORMAT' && job.extractionStatus !== 'NOT_TABULAR' && job.extractionStatus !== 'INVALID_FILE') {
        if (job.issues.some(i => i.severity === 'error') || job.extractionStatus === 'NEEDS_REVIEW') {
          job.extractionStatus = 'NEEDS_REVIEW';
        } else {
          job.extractionStatus = 'READY_FOR_REVIEW';
        }
      }

    } catch (err: any) {
      job.extractionStatus = 'PROCESSING_FAILED';
      job.issues.push({ message: err.message, severity: 'error' });
    }

    return job;
  }

  private static async processDelimited(buffer: Buffer, originalFilename: string, job: IngestionJob) {
    const csvResult = parseAndValidateCsv(buffer, originalFilename);
    const tableId = sanitizeIdentifier(path.basename(originalFilename, path.extname(originalFilename)));
    
    const profile = profileDataset(csvResult.allRows, csvResult.columns, originalFilename);
    job.candidateTables.push({
      id: tableId,
      name: tableId,
      columns: csvResult.columns,
      rows: csvResult.allRows,
      rowCount: csvResult.totalRows,
      issues: csvResult.issues,
      profile,
    });
    job.totalRowsPerTable[tableId] = csvResult.totalRows;
    job.selectedTables.push(tableId);
  }

  private static async processExcel(buffer: Buffer, job: IngestionJob) {
    // raw:false converts Excel date serials to JS Date strings; defval:null preserves empty cells
    const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
    
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      // Use header:1 to get raw arrays so we can detect title/header rows ourselves
      const rawRows: any[][] = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });

      // Skip empty/title rows and choose the first row that resembles real headers.
      let headerRowIdx = 0;
      let bestScore = -Infinity;
      const candidateLimit = Math.min(rawRows.length - 1, 10);
      for (let index = 0; index < candidateLimit; index++) {
        const values = rawRows[index].map((value: any) => String(value ?? '').trim()).filter(Boolean);
        const nextValues = rawRows[index + 1].filter((value: any) => value !== null && String(value).trim() !== '').length;
        if (values.length < 2) continue;
        const uniqueCount = new Set(values.map(value => value.toLowerCase())).size;
        const placeholderPenalty = values.filter(value => /^column[_ ]?\d+$/i.test(value)).length * 4;
        const numericPenalty = values.filter(value => /^-?\d+(\.\d+)?$/.test(value)).length * 2;
        const score = values.length * 2 + uniqueCount + Math.min(nextValues, values.length) - placeholderPenalty - numericPenalty;
        if (score > bestScore) {
          bestScore = score;
          headerRowIdx = index;
        }
      }
      if (headerRowIdx >= rawRows.length) continue;

      const headerRow = rawRows[headerRowIdx];
      const dataRows = rawRows.slice(headerRowIdx + 1).filter(
        (r: any[]) => r.some((v: any) => v !== null && String(v).trim() !== '')
      );

      if (dataRows.length === 0) continue;

      const tableId = sanitizeIdentifier(sheetName);
      const activeIndexes = headerRow
        .map((_: any, idx: number) => idx)
        .filter((idx: number) => dataRows.some((row: any[]) => {
          const value = row[idx];
          return value !== null && value !== undefined && String(value).trim() !== '';
        }));

      if (activeIndexes.length === 0) continue;

      const seenNames = new Map<string, number>();
      const cols = activeIndexes.map((sourceIndex: number, idx: number) => {
        const originalName = String(headerRow[sourceIndex] ?? `column_${idx + 1}`).trim() || `column_${idx + 1}`;
        const baseName = sanitizeIdentifier(originalName) || `col_${idx + 1}`;
        const count = seenNames.get(baseName) || 0;
        seenNames.set(baseName, count + 1);
        const internalName = count === 0 ? baseName : `${baseName}_${count + 1}`.substring(0, 60);
        if (count > 0) {
          job.issues.push({
            tableId,
            column: originalName,
            message: `Duplicate Excel header was renamed to '${internalName}'.`,
            severity: 'warning',
          });
        }
        return {
          originalName,
          internalName,
          detectedType: 'TEXT' as const,
          isNullable: true,
        };
      });

      const parsedRows = dataRows.map((r: any[]) => {
        const nr: any = {};
        for (let i = 0; i < cols.length; i++) {
          const v = r[activeIndexes[i]];
          // Preserve null/undefined as null; convert everything else to string for TEXT columns
          nr[cols[i].internalName] = (v === null || v === undefined || String(v).trim() === '') ? null : v;
        }
        return nr;
      });

      const profile = profileDataset(parsedRows, cols, sheetName);
      job.candidateTables.push({
        id: tableId,
        name: sheetName,
        columns: cols,
        rows: parsedRows,
        rowCount: parsedRows.length,
        issues: [],
        profile,
      });
      job.totalRowsPerTable[tableId] = parsedRows.length;
      job.selectedTables.push(tableId);
    }

    if (job.candidateTables.length === 0) {
      job.extractionStatus = 'NOT_TABULAR';
      job.issues.push({ message: 'No tabular data found in Excel sheets.', severity: 'warning' });
    }
  }


  private static async processJson(buffer: Buffer, job: IngestionJob) {
    let data: any;
    try {
      data = JSON.parse(buffer.toString('utf-8'));
    } catch (e: any) {
      job.extractionStatus = 'INVALID_FILE';
      job.issues.push({ message: `Invalid JSON: ${e.message}`, severity: 'error' });
      return;
    }

    // Support: array of records, or object with a top-level array property
    let arr: any[];
    if (Array.isArray(data)) {
      arr = data;
    } else if (data && typeof data === 'object') {
      // Find the first property that is a non-empty array of objects
      const arrayKey = Object.keys(data).find(
        k => Array.isArray(data[k]) && data[k].length > 0 && typeof data[k][0] === 'object'
      );
      if (arrayKey) {
        arr = data[arrayKey];
        job.issues.push({ message: `JSON record path selected: root.${arrayKey} (${arr.length} records)`, severity: 'warning' });
      } else {
        arr = [data]; // treat the whole object as one record
      }
    } else {
      job.extractionStatus = 'NOT_TABULAR';
      job.issues.push({ message: 'JSON file does not contain tabular records.', severity: 'warning' });
      return;
    }

    if (arr.length === 0) {
      job.extractionStatus = 'NOT_TABULAR';
      job.issues.push({ message: 'JSON array is empty.', severity: 'warning' });
      return;
    }

    // Build column union across ALL rows (not just first row) to catch sparse keys
    const allKeys = new Set<string>();
    for (const row of arr) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        for (const k of Object.keys(row)) allKeys.add(k);
      }
    }

    const tableId = 'json_data';
    const cols = Array.from(allKeys).map((k, idx) => ({
      originalName: k,
      internalName: sanitizeIdentifier(k) || `col_${idx}`,
      detectedType: 'TEXT' as const,
      isNullable: true,
    }));

    const parsedRows = arr.map((r: any) => {
      const nr: any = {};
      for (const col of cols) {
        const v = r?.[col.originalName];
        if (v === null || v === undefined) {
          nr[col.internalName] = null; // preserve null — do NOT stringify to "null"
        } else if (typeof v === 'object') {
          nr[col.internalName] = JSON.stringify(v); // nested object/array → JSON text
        } else {
          nr[col.internalName] = v;
        }
      }
      return nr;
    });

    job.candidateTables.push({
      id: tableId,
      name: tableId,
      columns: cols,
      rows: parsedRows,
      rowCount: parsedRows.length,
      issues: [],
    });
    job.totalRowsPerTable[tableId] = parsedRows.length;
    job.selectedTables.push(tableId);
  }

  private static async processJsonl(buffer: Buffer, job: IngestionJob) {
    const lines = buffer.toString('utf-8').split(/\r?\n/).filter(l => l.trim() !== '');
    const rows: any[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        rows.push(JSON.parse(lines[i]));
      } catch (e: any) {
        job.issues.push({ row: i + 1, message: `Invalid JSON on line ${i + 1}: ${e.message}`, severity: 'warning' });
      }
    }
    if (rows.length === 0) {
      job.extractionStatus = 'NOT_TABULAR';
      job.issues.push({ message: 'No valid JSON records found in JSONL file.', severity: 'warning' });
      return;
    }

    // Build column union across all rows
    const allKeys = new Set<string>();
    for (const row of rows) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        for (const k of Object.keys(row)) allKeys.add(k);
      }
    }

    const tableId = 'jsonl_data';
    const cols = Array.from(allKeys).map((k, idx) => ({
      originalName: k,
      internalName: sanitizeIdentifier(k) || `col_${idx}`,
      detectedType: 'TEXT' as const,
      isNullable: true,
    }));

    const parsedRows = rows.map((r: any) => {
      const nr: any = {};
      for (const col of cols) {
        const v = r?.[col.originalName];
        if (v === null || v === undefined) {
          nr[col.internalName] = null;
        } else if (typeof v === 'object') {
          nr[col.internalName] = JSON.stringify(v);
        } else {
          nr[col.internalName] = v;
        }
      }
      return nr;
    });

    job.candidateTables.push({
      id: tableId,
      name: tableId,
      columns: cols,
      rows: parsedRows,
      rowCount: parsedRows.length,
      issues: [],
    });
    job.totalRowsPerTable[tableId] = parsedRows.length;
    job.selectedTables.push(tableId);
  }

  private static async processDocx(buffer: Buffer, job: IngestionJob) {
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value;
    
    await this.processText(Buffer.from(text), 'document.docx', 'text/plain', job);
  }

  private static async processText(buffer: Buffer, filename: string, mimeType: string, job: IngestionJob) {
    job.extractionStatus = 'NEEDS_REVIEW';
    const text = buffer.toString('utf-8');

    if (text.trim() === '') {
      job.extractionStatus = 'NOT_TABULAR';
      job.issues.push({ message: `File "${filename}" is empty.`, severity: 'warning' });
      return;
    }

    try {
      const extracted = await geminiDocumentExtraction(text, filename, mimeType);
      if (!extracted || extracted.tables.length === 0) {
        job.extractionStatus = 'NOT_TABULAR';
        job.issues.push({
          message: `No tabular data found in "${filename}". The document may not contain structured tables suitable for import.`,
          severity: 'warning',
        });
        return;
      }

      for (let i = 0; i < extracted.tables.length; i++) {
        const tbl = extracted.tables[i];
        const tableId = sanitizeIdentifier(tbl.name || `extracted_table_${i + 1}`);
        job.candidateTables.push({
          id: tableId,
          name: tbl.name || `Table ${i + 1}`,
          columns: tbl.columns,
          rows: tbl.rows,
          rowCount: tbl.rows.length,
          issues: tbl.issues || [],
        });
        job.totalRowsPerTable[tableId] = tbl.rows.length;
        job.selectedTables.push(tableId);
      }
    } catch (e: any) {
      job.extractionStatus = 'PROCESSING_FAILED';
      const fmt = path.extname(filename).toUpperCase().replace('.', '') || 'text';
      job.issues.push({
        message: `${fmt} extraction failed: ${formatExtractionError(e)}`,
        severity: 'error',
      });
    }
  }

  private static async processDocumentAI(filePath: string, filename: string, mimeType: string, job: IngestionJob) {
    job.extractionStatus = 'NEEDS_REVIEW';
    try {
      const extracted = await geminiDocumentExtraction(null, filename, mimeType, filePath);
      if (!extracted || extracted.tables.length === 0) {
        job.extractionStatus = 'NOT_TABULAR';
        job.issues.push({
          message: `No tabular data could be extracted from ${path.extname(filename).toUpperCase() || 'document'} file "${filename}". The file may be scanned, image-only, or contain no structured tables.`,
          severity: 'warning',
        });
        return;
      }

      for (let i = 0; i < extracted.tables.length; i++) {
        const tbl = extracted.tables[i];
        const tableId = sanitizeIdentifier(tbl.name || `extracted_table_${i + 1}`);
        job.candidateTables.push({
          id: tableId,
          name: tbl.name || `Table ${i + 1}`,
          columns: tbl.columns,
          rows: tbl.rows,
          rowCount: tbl.rows.length,
          issues: tbl.issues || [],
        });
        job.totalRowsPerTable[tableId] = tbl.rows.length;
        job.selectedTables.push(tableId);
      }
    } catch (e: any) {
      job.extractionStatus = 'PROCESSING_FAILED';
      // Report the actual format in the error, not "CSV"
      const fmt = path.extname(filename).toUpperCase().replace('.', '') || 'document';
      job.issues.push({
        message: `${fmt} extraction failed: ${formatExtractionError(e)}`,
        severity: 'error',
      });
    }
  }
}
