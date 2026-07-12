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

export type SessionScalar = null | boolean | number | string

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
