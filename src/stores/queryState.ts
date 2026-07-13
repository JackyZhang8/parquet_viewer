import type { AppError, CellValue, ColumnSchema } from '../domain/types'

export type QueryStatus = 'idle' | 'queued' | 'running' | 'done' | 'cancelled' | 'error'

export interface QueryViewState {
  source?: 'filter' | 'sql'
  status: QueryStatus
  queryId?: string
  columns: ColumnSchema[]
  rows: CellValue[][]
  done: boolean
  returnedRows: string
  elapsedMs: string
  error?: AppError
  loadingBatch: boolean
  truncated: boolean
  stale: boolean
  generation: number
}

export const idleQueryState = (generation = 0): QueryViewState => ({
  status: 'idle', columns: [], rows: [], done: false, returnedRows: '0', elapsedMs: '0',
  loadingBatch: false, truncated: false, stale: false, generation,
})

export const internalQueryError = (): AppError => ({
  code: 'INTERNAL_ERROR', message: 'An internal error occurred', detail: null,
})
