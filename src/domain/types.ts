export type AppErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_PATH'
  | 'PERMISSION_DENIED'
  | 'INVALID_PARQUET'
  | 'STALE_FILE'
  | 'SQL_ERROR'
  | 'CANCELLED'
  | 'RESOURCE_EXHAUSTED'
  | 'INTERNAL_ERROR'

export interface AppError {
  code: AppErrorCode
  message: string
  detail: string | null
}

export interface ColumnSchema {
  name: string
  logicalType: string
  nullable: boolean
}

export interface FileMetadata {
  fileId: string
  path: string
  name: string
  sizeBytes: string
  rowCount: string
  rowGroupCount: number
  columns: ColumnSchema[]
}

export interface QueryRequest {
  fileId: string
  sql: string
  batchSize: number
  previewLimit: number
}

export interface QueryStarted {
  queryId: string
  columns: ColumnSchema[]
}

export interface QueryBatch {
  queryId: string
  rows: CellValue[][]
  done: boolean
  truncated: boolean
  returnedRows: string
  elapsedMs: string
}

export type ExportSource =
  | { kind: 'sql'; sql: string }
  | { kind: 'filter'; query: FilterQueryRequest }

export interface ExportInspectionRequest {
  fileId: string
  source: ExportSource
}

export interface ExportInspection {
  estimatedRows: string
  requiresConfirmation: boolean
}

export interface ExportRequest {
  fileId: string
  destination: string
  overwrite: boolean
  source: ExportSource
}

export interface ExportStarted {
  exportId: string
}

export type ExportStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'error'

export interface ExportProgress {
  exportId: string
  status: ExportStatus
  rowsWritten: string
  error: AppError | null
}

export type AppTheme = 'system' | 'light' | 'dark'
export type AppLanguage = 'en' | 'zh'

export interface AppSettings {
  language: AppLanguage
  theme: AppTheme
  batchSize: number
  previewLimit: number
  memoryLimitMb: number
  tempDirectory: string | null
  tempDiskWarningMb: number
  concurrency: number
  restoreTabs: boolean
}

export type ValueFilterOperator =
  | 'eq'
  | 'notEq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'

export type FilterOperator = ValueFilterOperator | 'isNull' | 'isNotNull'

export type FilterCondition =
  | {
      column: string
      operator: ValueFilterOperator
      value: SessionScalar
    }
  | {
      column: string
      operator: 'isNull' | 'isNotNull'
      value?: never
    }

export interface SortSpec {
  column: string
  direction: 'asc' | 'desc'
}

export interface FilterQueryRequest {
  selectedColumns: string[]
  filters: FilterCondition[]
  sorts: SortSpec[]
  previewLimit: number
}

export interface FilterQueryStartRequest {
  fileId: string
  query: FilterQueryRequest
  batchSize: number
}

/** Unsafe signed/unsigned integers cross the wire as decimal strings. */
export type CellValue =
  | null
  | boolean
  | number
  | string
  | CellValue[]
  | { [key: string]: CellValue }

export interface SessionSnapshot {
  version: number
  tabs: SessionTab[]
  activeTabId: string | null
}

export interface RestoredSession {
  snapshot: SessionSnapshot
  unavailableTabIds: string[]
  warning: string | null
}

/** Persisted tab state excludes transient query IDs and result rows. */
export interface SessionTab {
  id: string
  fileId: string
  path: string
  sqlDraft: string
  filters: SessionFilter[]
  sorts: SessionSort[]
  viewState: SessionViewState
}

export interface SessionFilter {
  column: string
  operator: SessionFilterOperator
  value: SessionScalar
}

export type SessionFilterOperator =
  | 'eq'
  | 'notEq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'isNull'
  | 'isNotNull'

export type SessionScalar =
  | { type: 'null' }
  | { type: 'boolean'; value: boolean }
  | { type: 'number'; value: number }
  | { type: 'integer'; value: string }
  | { type: 'decimal'; value: string }
  | { type: 'string'; value: string }

const I64_MIN_MAGNITUDE = '9223372036854775808'
const U64_MAX = '18446744073709551615'
const CANONICAL_INTEGER = /^(?:0|-[1-9]\d*|[1-9]\d*)$/
const CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$|^-(?:0\.(?!0+$)\d+|[1-9]\d*(?:\.\d+)?)$/

const isCanonicalSessionInteger = (value: string): boolean => {
  if (!CANONICAL_INTEGER.test(value)) return false
  const negative = value.startsWith('-')
  const magnitude = negative ? value.slice(1) : value
  const limit = negative ? I64_MIN_MAGNITUDE : U64_MAX
  return magnitude.length < limit.length ||
    (magnitude.length === limit.length && magnitude <= limit)
}

export const sessionInteger = (value: string): SessionScalar => {
  if (!CANONICAL_INTEGER.test(value)) {
    throw new Error('Session integer must use canonical decimal syntax')
  }
  if (!isCanonicalSessionInteger(value)) {
    throw new Error('Session integer is outside the supported i64/u64 range')
  }
  return { type: 'integer', value }
}

export const sessionDecimal = (value: string): SessionScalar => {
  if (!CANONICAL_DECIMAL.test(value)) {
    throw new Error('Session decimal must use canonical decimal syntax')
  }
  return { type: 'decimal', value }
}

export const sessionScalarFromNumber = (value: number): SessionScalar => {
  if (!Number.isFinite(value)) {
    throw new Error('Session scalar number must be finite')
  }
  if (!Number.isInteger(value)) return { type: 'number', value }
  if (!Number.isSafeInteger(value)) {
    throw new Error('Unsafe integer requires an explicit decimal integer string')
  }
  return sessionInteger(String(Object.is(value, -0) ? 0 : value))
}

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

export const isSessionScalar = (value: unknown): value is SessionScalar => {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'null':
      return hasExactKeys(value, ['type'])
    case 'boolean':
      return hasExactKeys(value, ['type', 'value']) && typeof value.value === 'boolean'
    case 'number':
      return (
        hasExactKeys(value, ['type', 'value']) &&
        typeof value.value === 'number' &&
        Number.isFinite(value.value) &&
        !Number.isInteger(value.value)
      )
    case 'integer':
      return (
        hasExactKeys(value, ['type', 'value']) &&
        typeof value.value === 'string' &&
        isCanonicalSessionInteger(value.value)
      )
    case 'decimal':
      return (
        hasExactKeys(value, ['type', 'value']) &&
        typeof value.value === 'string' &&
        CANONICAL_DECIMAL.test(value.value)
      )
    case 'string':
      return hasExactKeys(value, ['type', 'value']) && typeof value.value === 'string'
    default:
      return false
  }
}

export interface SessionSort {
  column: string
  direction: 'asc' | 'desc'
}

export interface SessionViewState {
  scrollTop: number
  scrollLeft: number
  sidebarWidth: number
  editorHeight: number
}

const APP_ERROR_CODES: ReadonlySet<string> = new Set<AppErrorCode>([
  'INVALID_ARGUMENT',
  'INVALID_PATH',
  'PERMISSION_DENIED',
  'INVALID_PARQUET',
  'STALE_FILE',
  'SQL_ERROR',
  'CANCELLED',
  'RESOURCE_EXHAUSTED',
  'INTERNAL_ERROR',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isDecimalString = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+$/.test(value)

const MAX_BATCH_ROWS = 5_000
const MAX_BATCH_COLUMNS = 512
const MAX_CELL_DEPTH = 16
const MAX_CELL_STRING_BYTES = 1024 * 1024
const MAX_BATCH_NODES = 2_000_000
const MAX_BATCH_VALIDATED_BYTES = 8 * 1024 * 1024
const utf8 = new TextEncoder()
type CellChild = { value: unknown; key?: string }
function* cellChildren(value: unknown[] | Record<string, unknown>): Generator<CellChild> {
  if (Array.isArray(value)) {
    for (const item of value) yield { value: item }
  } else {
    for (const key in value) if (Object.hasOwn(value, key)) yield { key, value: value[key] }
  }
}

const boundedCellRows = (rows: unknown[]): rows is CellValue[][] => {
  if (rows.length > MAX_BATCH_ROWS) return false
  let nodes = 0
  let bytes = 2 + rows.length
  const seen = new WeakSet<object>()
  for (const row of rows) {
    if (!Array.isArray(row) || row.length > MAX_BATCH_COLUMNS) return false
    bytes += 2 + row.length
    for (const cell of row) {
      let current: { value: unknown; depth: number } | undefined = { value: cell, depth: 0 }
      const stack: { children: Generator<CellChild>; depth: number }[] = []
      while (current) {
        const { value, depth } = current
        nodes += 1
        if (nodes > MAX_BATCH_NODES) return false
        if (value === null) bytes += 4
        else if (typeof value === 'boolean') bytes += 5
        else if (typeof value === 'number') {
          if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return false
          bytes += 24
        } else if (typeof value === 'string') {
          const size = utf8.encode(value).length
          if (size > MAX_CELL_STRING_BYTES) return false
          bytes += size + 2
        } else if (Array.isArray(value) || isRecord(value)) {
          if (depth >= MAX_CELL_DEPTH || seen.has(value)) return false
          seen.add(value); bytes += 2 + (Array.isArray(value) ? value.length : 0)
          stack.push({ children: cellChildren(value), depth: depth + 1 })
        } else return false
        if (bytes > MAX_BATCH_VALIDATED_BYTES) return false
        current = undefined
        while (stack.length && !current) {
          const frame = stack[stack.length - 1]
          const child = frame.children.next()
          if (child.done) { stack.pop(); continue }
          if (child.value.key !== undefined) {
            const keySize = utf8.encode(child.value.key).length
            if (keySize > MAX_CELL_STRING_BYTES) return false
            bytes += keySize + 4
          }
          current = { value: child.value.value, depth: frame.depth }
        }
      }
    }
  }
  return true
}

export const isAppError = (value: unknown): value is AppError =>
  isRecord(value) &&
  typeof value.code === 'string' &&
  APP_ERROR_CODES.has(value.code) &&
  typeof value.message === 'string' &&
  (value.detail === null || typeof value.detail === 'string')

export const isQueryBatch = (value: unknown): value is QueryBatch =>
  isRecord(value) &&
  hasExactKeys(value, ['queryId', 'rows', 'done', 'truncated', 'returnedRows', 'elapsedMs']) &&
  typeof value.queryId === 'string' && value.queryId.length > 0 &&
  Array.isArray(value.rows) &&
  boundedCellRows(value.rows) &&
  typeof value.done === 'boolean' &&
  typeof value.truncated === 'boolean' &&
  u64WireDecimal(value.returnedRows) &&
  u64WireDecimal(value.elapsedMs)

export const isExportProgress = (value: unknown): value is ExportProgress =>
  isRecord(value) &&
  hasExactKeys(value, ['exportId', 'status', 'rowsWritten', 'error']) &&
  typeof value.exportId === 'string' && value.exportId.length > 0 &&
  typeof value.status === 'string' &&
  new Set(['queued', 'running', 'completed', 'cancelled', 'error']).has(value.status) &&
  u64WireDecimal(value.rowsWritten) &&
  (value.error === null || isAppError(value.error))

export const isAppSettings = (value: unknown): value is AppSettings =>
  isRecord(value) &&
  hasExactKeys(value, ['language', 'theme', 'batchSize', 'previewLimit', 'memoryLimitMb', 'tempDirectory', 'tempDiskWarningMb', 'concurrency', 'restoreTabs']) &&
  (value.language === 'en' || value.language === 'zh') &&
  (value.theme === 'system' || value.theme === 'light' || value.theme === 'dark') &&
  typeof value.batchSize === 'number' && Number.isSafeInteger(value.batchSize) && value.batchSize >= 50 && value.batchSize <= 5000 &&
  typeof value.previewLimit === 'number' && Number.isSafeInteger(value.previewLimit) && value.previewLimit >= 100 && value.previewLimit <= 100000 &&
  typeof value.memoryLimitMb === 'number' && Number.isSafeInteger(value.memoryLimitMb) && value.memoryLimitMb >= 64 && value.memoryLimitMb <= 16384 &&
  (value.tempDirectory === null || (typeof value.tempDirectory === 'string' && value.tempDirectory.length > 0)) &&
  typeof value.tempDiskWarningMb === 'number' && Number.isSafeInteger(value.tempDiskWarningMb) && value.tempDiskWarningMb >= 64 && value.tempDiskWarningMb <= 102400 &&
  typeof value.concurrency === 'number' && Number.isSafeInteger(value.concurrency) && value.concurrency >= 1 && value.concurrency <= 4 &&
  typeof value.restoreTabs === 'boolean'

const u64WireDecimal = (value: unknown): value is string => {
  if (!isDecimalString(value) || !/^(?:0|[1-9]\d*)$/.test(value)) return false
  return value.length < U64_MAX.length || (value.length === U64_MAX.length && value <= U64_MAX)
}
