export type ProfileType = 'integer' | 'float' | 'boolean' | 'date' | 'datetime' | 'text';

export interface ColumnProfile {
  name: string;
  detectedType: ProfileType;
  rowCount: number;
  nullCount: number;
  nullPercentage: number;
  uniqueCount: number;
  uniquePercentage: number;
  sampleValues: unknown[];
  min?: number | string;
  max?: number | string;
  isConstant: boolean;
  possiblePrimaryKey: boolean;
  categoricalLike: boolean;
  invalidCount: number;
  outlierCount: number;
}

export interface DatasetProfile {
  datasetName?: string;
  rows: number;
  columns: number;
  duplicateRows: number;
  emptyColumns: string[];
  warnings: string[];
  columnsProfile: ColumnProfile[];
  generatedAt: string;
  profilingMs: number;
}

const NULL_VALUES = new Set(['', 'null', 'n/a', 'na', 'none']);
const BOOLEAN_PATTERN = /^(true|false|yes|no|t|f|0|1)$/i;
const DATE_PATTERN = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/;

function normalized(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function isNullValue(value: unknown): boolean {
  return NULL_VALUES.has(normalized(value).toLowerCase());
}

function dateKind(values: string[]): 'date' | 'datetime' | null {
  if (values.length === 0) return null;
  const parsed = values.filter(value => !Number.isNaN(Date.parse(value)));
  if (parsed.length !== values.length) return null;
  return values.every(value => DATE_PATTERN.test(value)) ? 'date' : 'datetime';
}

function detectType(values: string[]): { type: ProfileType; invalidCount: number } {
  if (values.length === 0) return { type: 'text', invalidCount: 0 };
  if (values.every(value => BOOLEAN_PATTERN.test(value))) return { type: 'boolean', invalidCount: 0 };

  const integerValues = values.filter(value => /^[-+]?\d+$/.test(value));
  if (integerValues.length === values.length && !values.some(value => /^0\d+/.test(value))) {
    return { type: 'integer', invalidCount: 0 };
  }

  const numericValues = values.filter(value => /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value) && Number.isFinite(Number(value)));
  if (numericValues.length === values.length && !values.some(value => /^0\d+/.test(value))) {
    return { type: 'float', invalidCount: 0 };
  }

  const date = dateKind(values);
  if (date) return { type: date, invalidCount: 0 };
  return { type: 'text', invalidCount: 0 };
}

function representativeSample(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  const indexes = [0, Math.floor(values.length / 4), Math.floor(values.length / 2), Math.floor(values.length * 0.75), values.length - 1];
  for (const index of indexes) {
    const value = values[index];
    const key = JSON.stringify(value);
    if (value !== undefined && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  for (const value of values) {
    if (result.length >= 8) break;
    const key = JSON.stringify(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

export function profileDataset(
  rows: Record<string, unknown>[],
  columns: { internalName: string; originalName?: string }[],
  datasetName?: string
): DatasetProfile {
  const started = Date.now();
  const rowCount = rows.length;
  let duplicateRows = 0;
  const rowKeys = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify(row);
    if (rowKeys.has(key)) duplicateRows++;
    rowKeys.add(key);
  }

  const profiles = columns.map(column => {
    const values = rows.map(row => row[column.internalName]);
    const nonNull = values.filter(value => !isNullValue(value));
    const strings = nonNull.map(normalized);
    const { type, invalidCount } = detectType(strings);
    const unique = new Set(strings);
    const numeric = type === 'integer' || type === 'float'
      ? strings.map(Number).filter(Number.isFinite)
      : [];
    const sorted = [...numeric].sort((a, b) => a - b);
    const outlierCount = numeric.length > 4
      ? numeric.filter(value => {
        const mean = numeric.reduce((sum, item) => sum + item, 0) / numeric.length;
        const variance = numeric.reduce((sum, item) => sum + (item - mean) ** 2, 0) / numeric.length;
        return variance > 0 && Math.abs(value - mean) > Math.sqrt(variance) * 3;
      }).length
      : 0;
    const originalName = column.originalName || column.internalName;
    return {
      name: originalName,
      detectedType: type,
      rowCount,
      nullCount: values.length - nonNull.length,
      nullPercentage: rowCount ? Number((((values.length - nonNull.length) / rowCount) * 100).toFixed(2)) : 0,
      uniqueCount: unique.size,
      uniquePercentage: nonNull.length ? Number(((unique.size / nonNull.length) * 100).toFixed(2)) : 0,
      sampleValues: representativeSample(nonNull),
      min: numeric.length ? sorted[0] : undefined,
      max: numeric.length ? sorted[sorted.length - 1] : undefined,
      isConstant: unique.size <= 1 && nonNull.length > 0,
      possiblePrimaryKey: rowCount > 0 && nonNull.length === rowCount && unique.size === rowCount,
      categoricalLike: type === 'text' && unique.size <= Math.max(20, Math.ceil(nonNull.length * 0.1)),
      invalidCount,
      outlierCount,
    };
  });

  const emptyColumns = profiles.filter(column => column.nullCount === rowCount).map(column => column.name);
  const warnings = [
    ...(duplicateRows ? [`${duplicateRows} duplicate row${duplicateRows === 1 ? '' : 's'} detected.`] : []),
    ...profiles.filter(column => column.nullCount > 0).map(column => `${column.name}: ${column.nullCount} missing value${column.nullCount === 1 ? '' : 's'}.`),
    ...profiles.filter(column => column.isConstant).map(column => `${column.name}: constant column detected.`),
    ...profiles.filter(column => column.outlierCount > 0).map(column => `${column.name}: ${column.outlierCount} possible outlier${column.outlierCount === 1 ? '' : 's'} detected.`),
  ];

  return {
    datasetName,
    rows: rowCount,
    columns: columns.length,
    duplicateRows,
    emptyColumns,
    warnings,
    columnsProfile: profiles,
    generatedAt: new Date().toISOString(),
    profilingMs: Date.now() - started,
  };
}
