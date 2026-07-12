export type AppErrorCode =
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
  returnedRows: string
  elapsedMs: string
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
  | { type: 'string'; value: string }

const I64_MIN = -(1n << 63n)
const U64_MAX = (1n << 64n) - 1n
const CANONICAL_INTEGER = /^(?:0|-[1-9]\d*|[1-9]\d*)$/

const isCanonicalSessionInteger = (value: string): boolean => {
  if (!CANONICAL_INTEGER.test(value)) return false
  const integer = BigInt(value)
  return integer >= I64_MIN && integer <= U64_MAX
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

const isCellValue = (value: unknown): value is CellValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))
  }
  if (Array.isArray(value)) return value.every(isCellValue)
  return isRecord(value) && Object.values(value).every(isCellValue)
}

export const isAppError = (value: unknown): value is AppError =>
  isRecord(value) &&
  typeof value.code === 'string' &&
  APP_ERROR_CODES.has(value.code) &&
  typeof value.message === 'string' &&
  (value.detail === null || typeof value.detail === 'string')

export const isQueryBatch = (value: unknown): value is QueryBatch =>
  isRecord(value) &&
  typeof value.queryId === 'string' &&
  Array.isArray(value.rows) &&
  value.rows.every((row) => Array.isArray(row) && row.every(isCellValue)) &&
  typeof value.done === 'boolean' &&
  isDecimalString(value.returnedRows) &&
  isDecimalString(value.elapsedMs)
