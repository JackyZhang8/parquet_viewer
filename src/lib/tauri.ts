import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import { revealItemInDir as reveal } from '@tauri-apps/plugin-opener'
import type { AppError, FileMetadata, RestoredSession, SessionSnapshot } from '../domain/types'
import { isAppError } from '../domain/types'

export type OpenFileOutcome =
  | { ok: true; metadata: FileMetadata }
  | { ok: false; error: AppError }

export interface DesktopApi {
  openFiles(paths: string[]): Promise<OpenFileOutcome[]>
  closeFile(fileId: string): Promise<void>
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

const metadata = (value: unknown): FileMetadata | null => {
  if (!record(value) || !Array.isArray(value.columns)) return null
  const columns = value.columns.filter(record)
  if (
    typeof value.fileId !== 'string' || typeof value.path !== 'string' ||
    typeof value.name !== 'string' || typeof value.sizeBytes !== 'string' ||
    typeof value.rowCount !== 'string' || typeof value.rowGroupCount !== 'number' ||
    columns.length !== value.columns.length ||
    !columns.every((column) => typeof column.name === 'string' && typeof column.logicalType === 'string' && typeof column.nullable === 'boolean')
  ) return null
  return value as unknown as FileMetadata
}

export const normalizeOpenOutcomes = (value: unknown): OpenFileOutcome[] => {
  if (!Array.isArray(value)) throw internalError()
  return value.map((item) => {
    if (!record(item)) return { ok: false, error: internalError() }
    const okValue = item.Ok ?? item.ok
    const errorValue = item.Err ?? item.err
    const parsed = metadata(okValue)
    if (parsed) return { ok: true, metadata: parsed }
    if (isAppError(errorValue)) return { ok: false, error: errorValue }
    return { ok: false, error: internalError() }
  })
}

const restoredSession = (value: unknown): RestoredSession => {
  if (!record(value) || !record(value.snapshot) || !Array.isArray(value.snapshot.tabs) ||
      !Array.isArray(value.unavailableTabIds) ||
      !(value.warning === null || typeof value.warning === 'string')) throw internalError()
  return value as unknown as RestoredSession
}

export const desktopApi: DesktopApi = {
  async openFiles(paths) {
    return normalizeOpenOutcomes(await invoke('open_files', { paths }))
  },
  closeFile: (fileId) => invoke('close_file', { fileId }),
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
