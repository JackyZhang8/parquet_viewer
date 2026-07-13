import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import { revealItemInDir as reveal } from '@tauri-apps/plugin-opener'
import type {
  AppError, FileMetadata, FilterQueryStartRequest, QueryBatch, QueryStarted, RestoredSession,
  SessionSnapshot,
} from '../domain/types'
import { isAppError, isQueryBatch, isSessionScalar } from '../domain/types'

export type OpenFileOutcome =
  | { ok: true; metadata: FileMetadata }
  | { ok: false; error: AppError }

export interface DesktopApi {
  openFiles(paths: string[]): Promise<OpenFileOutcome[]>
  closeFile(fileId: string): Promise<void>
  startFilterQuery(request: FilterQueryStartRequest): Promise<QueryStarted>
  fetchQueryBatch(queryId: string): Promise<QueryBatch>
  cancelQuery(queryId: string): Promise<void>
  loadSession(): Promise<RestoredSession>
  saveSession(snapshot: SessionSnapshot): Promise<void>
  pickParquetFiles(): Promise<string[] | null>
  onFileDrop(callback: (paths: string[]) => void): Promise<() => void>
  revealItemInDir(path: string): Promise<void>
}

const internalError = (): AppError => ({
  code: 'INTERNAL_ERROR',
  message: 'An internal error occurred',
  detail: null,
})

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

const U64_MAX = '18446744073709551615'
const u64Decimal = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return false
  return value.length < U64_MAX.length || (value.length === U64_MAX.length && value <= U64_MAX)
}

const metadata = (value: unknown): FileMetadata | null => {
  if (!record(value) || !exactKeys(value, ['fileId', 'path', 'name', 'sizeBytes', 'rowCount', 'rowGroupCount', 'columns']) ||
      !Array.isArray(value.columns)) return null
  if (
    typeof value.fileId !== 'string' || value.fileId.length === 0 ||
    typeof value.path !== 'string' || value.path.length === 0 ||
    typeof value.name !== 'string' || value.name.length === 0 ||
    !u64Decimal(value.sizeBytes) || !u64Decimal(value.rowCount) ||
    !unsigned(value.rowGroupCount, 0xffff_ffff) ||
    !value.columns.every((column) => record(column) && exactKeys(column, ['name', 'logicalType', 'nullable']) &&
      typeof column.name === 'string' && column.name.length > 0 &&
      typeof column.logicalType === 'string' && column.logicalType.length > 0 &&
      typeof column.nullable === 'boolean')
  ) return null
  return value as unknown as FileMetadata
}

const queryStarted = (value: unknown): QueryStarted => {
  if (!record(value) || !exactKeys(value, ['queryId', 'columns']) ||
      typeof value.queryId !== 'string' || value.queryId.length === 0 ||
      !Array.isArray(value.columns) || value.columns.length > 512 ||
      !value.columns.every((column) => record(column) && exactKeys(column, ['name', 'logicalType', 'nullable']) &&
        typeof column.name === 'string' && column.name.length > 0 &&
        typeof column.logicalType === 'string' && column.logicalType.length > 0 &&
        typeof column.nullable === 'boolean')) throw internalError()
  return value as unknown as QueryStarted
}

const queryBatch = (value: unknown): QueryBatch => {
  if (!isQueryBatch(value)) throw internalError()
  return value
}

export const normalizeOpenOutcomes = (value: unknown): OpenFileOutcome[] => {
  if (!Array.isArray(value)) throw internalError()
  return value.map((item) => {
    if (!record(item) || Object.keys(item).length !== 1) return { ok: false, error: internalError() }
    if (Object.hasOwn(item, 'Ok')) {
      const parsed = metadata(item.Ok)
      if (parsed) return { ok: true, metadata: parsed }
    }
    if (Object.hasOwn(item, 'Err') && record(item.Err) && exactKeys(item.Err, ['code', 'message', 'detail']) && isAppError(item.Err)) {
      return { ok: false, error: item.Err }
    }
    return { ok: false, error: internalError() }
  })
}

const unsigned = (value: unknown, max: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const FILTER_OPERATORS = new Set(['eq', 'notEq', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'isNull', 'isNotNull'])

const sessionTab = (value: unknown): value is RestoredSession['snapshot']['tabs'][number] => {
  if (!record(value) || !exactKeys(value, ['id', 'fileId', 'path', 'sqlDraft', 'filters', 'sorts', 'viewState'])) return false
  if (typeof value.id !== 'string' || typeof value.fileId !== 'string' || typeof value.path !== 'string' || typeof value.sqlDraft !== 'string') return false
  if (!Array.isArray(value.filters) || !value.filters.every((filter) =>
    record(filter) && exactKeys(filter, ['column', 'operator', 'value']) &&
    typeof filter.column === 'string' && typeof filter.operator === 'string' &&
    FILTER_OPERATORS.has(filter.operator) && isSessionScalar(filter.value))) return false
  if (!Array.isArray(value.sorts) || !value.sorts.every((sort) =>
    record(sort) && exactKeys(sort, ['column', 'direction']) && typeof sort.column === 'string' &&
    (sort.direction === 'asc' || sort.direction === 'desc'))) return false
  const view = value.viewState
  return record(view) && exactKeys(view, ['scrollTop', 'scrollLeft', 'sidebarWidth', 'editorHeight']) &&
    unsigned(view.scrollTop, 0xffff_ffff) && unsigned(view.scrollLeft, 0xffff_ffff) &&
    unsigned(view.sidebarWidth, 0xffff) && unsigned(view.editorHeight, 0xffff)
}

const restoredSession = (value: unknown): RestoredSession => {
  if (!record(value) || !exactKeys(value, ['snapshot', 'unavailableTabIds', 'warning']) ||
      !record(value.snapshot) || !exactKeys(value.snapshot, ['version', 'tabs', 'activeTabId']) ||
      value.snapshot.version !== 1 || !Array.isArray(value.snapshot.tabs) || !value.snapshot.tabs.every(sessionTab) ||
      !(value.snapshot.activeTabId === null || typeof value.snapshot.activeTabId === 'string') ||
      !Array.isArray(value.unavailableTabIds) || !value.unavailableTabIds.every((id) => typeof id === 'string') ||
      !(value.warning === null || typeof value.warning === 'string')) throw internalError()
  const ids = new Set(value.snapshot.tabs.map((tab) => tab.id))
  if (ids.size !== value.snapshot.tabs.length ||
      (value.snapshot.activeTabId !== null && !ids.has(value.snapshot.activeTabId)) ||
      !value.unavailableTabIds.every((id) => ids.has(id))) throw internalError()
  return value as unknown as RestoredSession
}

export const desktopApi: DesktopApi = {
  async openFiles(paths) {
    const outcomes = normalizeOpenOutcomes(await invoke('open_files', { paths }))
    if (outcomes.length !== paths.length) {
      await Promise.all(outcomes.filter((outcome) => outcome.ok).map(async (outcome) => {
        try { await invoke('close_file', { fileId: outcome.metadata.fileId }) } catch { /* best effort */ }
      }))
      throw internalError()
    }
    return outcomes
  },
  closeFile: (fileId) => invoke('close_file', { fileId }),
  async startFilterQuery(request) {
    return queryStarted(await invoke('start_filter_query', { request }))
  },
  async fetchQueryBatch(queryId) {
    return queryBatch(await invoke('fetch_query_batch', { queryId }))
  },
  cancelQuery: (queryId) => invoke('cancel_query', { queryId }),
  async loadSession() {
    return restoredSession(await invoke('load_session'))
  },
  saveSession: (snapshot) => invoke('save_session', { snapshot }),
  async pickParquetFiles() {
    const selected = await open({ multiple: true, filters: [{ name: 'Parquet', extensions: ['parquet'] }] })
    if (selected === null) return null
    return Array.isArray(selected) ? selected : [selected]
  },
  async onFileDrop(callback) {
    return getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'drop') callback(payload.paths)
    })
  },
  revealItemInDir: reveal,
}
