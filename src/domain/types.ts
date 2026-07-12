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
  sizeBytes: number
  rowCount: number
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
  rows: unknown[][]
  done: boolean
  returnedRows: number
  elapsedMs: number
}

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
  filters: unknown
  sorts: unknown
  viewState: unknown
}
