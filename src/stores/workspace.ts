import { createStore, type StoreApi } from 'zustand/vanilla'
import type {
  AppError, FileMetadata, FilterQueryRequest, SessionFilter, SessionSnapshot, SessionSort, SessionViewState,
} from '../domain/types'
import { isAppError } from '../domain/types'
import type { DesktopApi, OpenFileOutcome } from '../lib/tauri'
import { idleQueryState, internalQueryError, type QueryViewState } from './queryState'

export type TabStatus = 'loading' | 'ready' | 'unavailable' | 'error'

export interface WorkspaceTab {
  id: string
  fileId: string
  path: string
  metadata?: FileMetadata
  error?: AppError
  status: TabStatus
  sqlDraft: string
  filters: SessionFilter[]
  sorts: SessionSort[]
  viewState: SessionViewState
}

type HydrationState = 'idle' | 'loading' | 'ready'

export interface WorkspaceState {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  opening: number
  pathErrors: Record<string, AppError>
  hydrationState: HydrationState
  warning: string | null
  queriesByTab: Record<string, QueryViewState>
  reportError(key: string, error: unknown): void
  resume(): void
  openPaths(paths: string[]): Promise<void>
  hydrate(): Promise<void>
  activateTab(id: string): void
  closeTab(id: string): Promise<void>
  closeOthers(id: string): Promise<void>
  closeRight(id: string): Promise<void>
  reorderTabs(from: number, to: number): void
  setSqlDraft(id: string, sqlDraft: string): void
  setFilters(id: string, filters: SessionFilter[]): void
  setSorts(id: string, sorts: SessionSort[]): void
  setViewState(id: string, viewState: Partial<SessionViewState>): void
  runFilterQuery(tabId: string, request: FilterQueryRequest): Promise<void>
  runSqlQuery(tabId: string, sql: string, previewLimit?: number, batchSize?: number): Promise<void>
  loadNextBatch(tabId: string): Promise<void>
  cancelQuery(tabId: string): Promise<void>
  flushSave(): Promise<void>
  dispose(): void
}

const defaultViewState = (): SessionViewState => ({
  scrollTop: 0, scrollLeft: 0, sidebarWidth: 260, editorHeight: 180,
})

let nextTab = 0
const tabId = () => `tab-${Date.now().toString(36)}-${(++nextTab).toString(36)}`

const snapshot = (state: WorkspaceState): SessionSnapshot => ({
  version: 1,
  tabs: state.tabs.map(({ id, fileId, path, sqlDraft, filters, sorts, viewState }) => ({
    id, fileId, path, sqlDraft, filters, sorts, viewState,
  })),
  activeTabId: state.activeTabId,
})

export const createWorkspaceStore = (
  api: DesktopApi,
  options: { saveDelayMs?: number } = {},
): StoreApi<WorkspaceState> => {
  const delay = options.saveDelayMs ?? 300
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let hydrating: Promise<void> | undefined
  let disposed = false
  let store: StoreApi<WorkspaceState>
  const queryLimits = new Map<string, number>()
  const utf8 = new TextEncoder()

  const sanitized = (error: unknown): AppError => isAppError(error) ? {
    code: error.code, message: error.message, detail: error.detail,
  } : {
    code: 'INTERNAL_ERROR', message: 'An internal error occurred', detail: null,
  }

  const saveNow = async () => {
    if (disposed || store.getState().hydrationState !== 'ready') return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = undefined
    try { await api.saveSession(snapshot(store.getState())) } catch (error) { store.getState().reportError('Session save', error) }
  }
  const scheduleSave = () => {
    if (disposed || store.getState().hydrationState !== 'ready') return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { void saveNow() }, delay)
  }
  const updateTabs = (tabs: WorkspaceTab[], activeTabId?: string | null) => {
    store.setState({ tabs, ...(activeTabId !== undefined ? { activeTabId } : {}) })
    scheduleSave()
  }
  const closeIds = async (ids: Set<string>) => {
    const state = store.getState()
    const removed = state.tabs.filter((tab) => ids.has(tab.id))
    if (!removed.length) return
    const queryIds = removed.flatMap((tab) => {
      const queryId = state.queriesByTab[tab.id]?.queryId
      return queryId ? [queryId] : []
    })
    const remaining = state.tabs.filter((tab) => !ids.has(tab.id))
    let active = state.activeTabId
    if (active && ids.has(active)) {
      const activeIndex = state.tabs.findIndex((tab) => tab.id === active)
      const previous = remaining.filter((tab) => state.tabs.indexOf(tab) < activeIndex)
      active = remaining.find((tab) => state.tabs.indexOf(tab) > activeIndex)?.id ??
        previous[previous.length - 1]?.id ?? null
    }
    const queriesByTab = { ...state.queriesByTab }
    for (const id of ids) { delete queriesByTab[id]; queryLimits.delete(id) }
    store.setState({ tabs: remaining, activeTabId: active, queriesByTab })
    scheduleSave()
    await Promise.all(queryIds.map(async (queryId) => { try { await api.cancelQuery(queryId) } catch { /* best effort */ } }))
    const remainingIds = new Set(remaining.map((tab) => tab.fileId))
    await Promise.all([...new Set(removed.filter((tab) => tab.status === 'ready').map((tab) => tab.fileId))]
      .filter((fileId) => fileId && !remainingIds.has(fileId))
      .map(async (fileId) => { try { await api.closeFile(fileId) } catch (error) { store.getState().reportError(`Close ${fileId}`, error) } }))
  }

  const openIntoWorkspace = async (paths: string[]) => {
    store.setState((state) => ({ opening: state.opening + paths.length }))
    let outcomes: OpenFileOutcome[]
    try { outcomes = await api.openFiles(paths) } catch (error) {
      const appError = sanitized(error)
      store.setState((state) => ({ opening: Math.max(0, state.opening - paths.length), pathErrors: { ...state.pathErrors, ...Object.fromEntries(paths.map((path) => [path, appError])) } }))
      return
    }
    let tabs = [...store.getState().tabs]
    let active = store.getState().activeTabId
    const errors = { ...store.getState().pathErrors }
    paths.forEach((path, index) => {
      const outcome = outcomes[index] ?? { ok: false, error: sanitized(null) } as const
      const retry = tabs.find((tab) => tab.path === path && (tab.status === 'unavailable' || tab.status === 'error'))
      if (!outcome.ok) {
        errors[path] = outcome.error
        if (retry) tabs = tabs.map((tab) => tab.id === retry.id ? { ...tab, status: 'error', error: outcome.error } : tab)
        return
      }
      delete errors[path]
      const existingFile = tabs.find((tab) => tab.fileId === outcome.metadata.fileId && tab.status === 'ready')
      if (existingFile) { active = existingFile.id; return }
      if (retry) {
        tabs = tabs.map((tab) => tab.id === retry.id ? { ...tab, fileId: outcome.metadata.fileId, path: outcome.metadata.path, metadata: outcome.metadata, status: 'ready', error: undefined } : tab)
        active = retry.id
      } else {
        const id = tabId()
        tabs.push({ id, fileId: outcome.metadata.fileId, path: outcome.metadata.path, metadata: outcome.metadata, status: 'ready', sqlDraft: '', filters: [], sorts: [], viewState: defaultViewState() })
        active ??= id
      }
    })
    store.setState((state) => ({ tabs, activeTabId: active, pathErrors: errors, opening: Math.max(0, state.opening - paths.length) }))
    scheduleSave()
  }

  const invalidArgument = (message: string): AppError => ({ code: 'INVALID_ARGUMENT', message, detail: null })
  const canRunQuery = (tabId: string) => store.getState().activeTabId === tabId &&
    store.getState().tabs.some((tab) => tab.id === tabId && tab.status === 'ready')
  const beginInvalidQuery = (tabId: string, source: 'filter' | 'sql', error: AppError) => {
    const previous = store.getState().queriesByTab[tabId] ?? idleQueryState()
    if (previous.queryId) void api.cancelQuery(previous.queryId).catch(() => undefined)
    store.setState((state) => ({ queriesByTab: { ...state.queriesByTab, [tabId]: {
      ...previous, status: 'error', queryId: undefined, loadingBatch: false, done: false,
      stale: previous.rows.length > 0, generation: previous.generation + 1, error, source,
    } } }))
  }
  const runQuery = async (
    tabId: string, source: 'filter' | 'sql', previewLimit: number, batchSize: number,
    start: (tab: WorkspaceTab) => Promise<{ queryId: string; columns: FileMetadata['columns'] }>,
  ) => {
    const tab = store.getState().tabs.find((item) => item.id === tabId)
    if (!tab || tab.status !== 'ready' || store.getState().activeTabId !== tabId) return
    const previous = store.getState().queriesByTab[tabId] ?? idleQueryState()
    const generation = previous.generation + 1
    if (previous.queryId) void api.cancelQuery(previous.queryId).catch(() => undefined)
    store.setState((state) => ({ queriesByTab: { ...state.queriesByTab, [tabId]: {
      ...previous, status: 'queued', error: undefined, loadingBatch: false, done: false,
      stale: previous.rows.length > 0, generation, queryId: undefined, source,
    } } }))
    try {
      const started = await start(tab)
      const current = store.getState().queriesByTab[tabId]
      if (!current || current.generation !== generation) {
        try { await api.cancelQuery(started.queryId) } catch { /* best effort */ }
        return
      }
      queryLimits.set(tabId, previewLimit)
      store.setState((state) => ({ queriesByTab: { ...state.queriesByTab, [tabId]: {
        ...idleQueryState(generation), status: 'running', queryId: started.queryId, columns: started.columns, source,
      } } }))
      await store.getState().loadNextBatch(tabId)
    } catch (error) {
      const current = store.getState().queriesByTab[tabId]
      if (!current || current.generation !== generation) return
      store.setState((state) => ({ queriesByTab: { ...state.queriesByTab, [tabId]: {
        ...current, status: 'error', loadingBatch: false, stale: current.rows.length > 0, error: sanitized(error),
      } } }))
    }
  }

  store = createStore<WorkspaceState>((set, get) => ({
    tabs: [], activeTabId: null, opening: 0, pathErrors: {}, hydrationState: 'idle', warning: null, queriesByTab: {},
    async openPaths(input) {
      const paths = [...new Set(input.filter((path) => path.length > 0))]
      if (!paths.length) return
      if (get().hydrationState !== 'ready') await get().hydrate()
      await openIntoWorkspace(paths)
    },
    async hydrate() {
      if (get().hydrationState === 'ready') return
      if (hydrating) return hydrating
      set({ hydrationState: 'loading' })
      hydrating = (async () => {
        try {
          const restored = await api.loadSession()
          const unavailable = new Set(restored.unavailableTabIds)
          const tabs: WorkspaceTab[] = restored.snapshot.tabs.map((tab) => ({ ...tab, metadata: undefined, status: unavailable.has(tab.id) ? 'unavailable' : 'loading' }))
          set({ tabs, activeTabId: restored.snapshot.activeTabId, warning: restored.warning })
          const available = tabs.filter((tab) => !unavailable.has(tab.id))
          if (available.length) {
            let outcomes: OpenFileOutcome[]
            try { outcomes = await api.openFiles(available.map((tab) => tab.path)) } catch (error) {
              outcomes = available.map(() => ({ ok: false, error: sanitized(error) }))
            }
            let liveTabs = [...get().tabs]
            let active = get().activeTabId
            const errors = { ...get().pathErrors }
            const successful = new Map<string, { original: WorkspaceTab; outcome: Extract<OpenFileOutcome, { ok: true }> }[]>()
            available.forEach((original, index) => {
              const outcome = outcomes[index] ?? { ok: false, error: sanitized(null) } as const
              if (outcome.ok) {
                const group = successful.get(outcome.metadata.fileId) ?? []
                group.push({ original, outcome })
                successful.set(outcome.metadata.fileId, group)
                delete errors[original.path]
              } else if (liveTabs.some((tab) => tab.id === original.id)) {
                errors[original.path] = outcome.error
                liveTabs = liveTabs.map((tab) => tab.id === original.id ? { ...tab, status: 'error', error: outcome.error } : tab)
              }
            })
            const returnedIds = new Set(successful.keys())
            for (const [fileId, group] of successful) {
              const restoredIds = new Set(group.map(({ original }) => original.id))
              const members = liveTabs.filter((tab) => restoredIds.has(tab.id) || (tab.status === 'ready' && tab.fileId === fileId))
              if (!members.length) continue
              const retained = members.find((tab) => tab.id === active) ?? members[0]
              const restored = group.find(({ original }) => original.id === retained.id)
              liveTabs = liveTabs
                .filter((tab) => !members.some((member) => member.id === tab.id) || tab.id === retained.id)
                .map((tab) => tab.id === retained.id && restored ? {
                  ...tab, fileId, path: restored.outcome.metadata.path, metadata: restored.outcome.metadata,
                  status: 'ready', error: undefined,
                } : tab)
              if (active && !liveTabs.some((tab) => tab.id === active)) active = retained.id
            }
            set({ tabs: liveTabs, activeTabId: active, pathErrors: errors })
            for (const fileId of returnedIds) {
              if (!liveTabs.some((tab) => tab.status === 'ready' && tab.fileId === fileId)) {
                try { await api.closeFile(fileId) } catch (error) { get().reportError(`Close ${fileId}`, error) }
              }
            }
          }
        } catch { set({ warning: 'The saved workspace could not be restored' }) }
        finally { set({ hydrationState: 'ready' }) }
      })()
      return hydrating
    },
    reportError(key, error) { set((state) => ({ pathErrors: { ...state.pathErrors, [key]: sanitized(error) } })) },
    resume() { disposed = false },
    activateTab: (id) => { if (get().tabs.some((tab) => tab.id === id)) { set({ activeTabId: id }); scheduleSave() } },
    closeTab: (id) => closeIds(new Set([id])),
    closeOthers: (id) => closeIds(new Set(get().tabs.filter((tab) => tab.id !== id).map((tab) => tab.id))),
    closeRight: (id) => { const index = get().tabs.findIndex((tab) => tab.id === id); return closeIds(new Set(get().tabs.slice(index + 1).map((tab) => tab.id))) },
    reorderTabs(from, to) { const tabs = [...get().tabs]; if (from < 0 || to < 0 || from >= tabs.length || to >= tabs.length) return; const [tab] = tabs.splice(from, 1); tabs.splice(to, 0, tab); updateTabs(tabs) },
    setSqlDraft(id, sqlDraft) { updateTabs(get().tabs.map((tab) => tab.id === id ? { ...tab, sqlDraft } : tab)) },
    setFilters(id, filters) { updateTabs(get().tabs.map((tab) => tab.id === id ? { ...tab, filters } : tab)) },
    setSorts(id, sorts) { updateTabs(get().tabs.map((tab) => tab.id === id ? { ...tab, sorts } : tab)) },
    setViewState(id, viewState) { updateTabs(get().tabs.map((tab) => tab.id === id ? { ...tab, viewState: { ...tab.viewState, ...viewState } } : tab)) },
    async runFilterQuery(tabId, request) {
      if (!canRunQuery(tabId)) return
      if (!Number.isSafeInteger(request.previewLimit) || request.previewLimit < 1 || request.previewLimit > 10_000) {
        beginInvalidQuery(tabId, 'filter', invalidArgument('Preview limit must be between 1 and 10000'))
        return
      }
      await runQuery(tabId, 'filter', request.previewLimit, 500, (tab) => api.startFilterQuery({ fileId: tab.fileId, query: request, batchSize: 500 }))
    },
    async runSqlQuery(tabId, sql, previewLimit = 10_000, batchSize = 500) {
      if (!canRunQuery(tabId)) return
      if (sql.trim().length === 0) { beginInvalidQuery(tabId, 'sql', invalidArgument('SQL query must not be empty')); return }
      if (utf8.encode(sql).length > 256 * 1024) { beginInvalidQuery(tabId, 'sql', invalidArgument('SQL query must not exceed 256 KiB')); return }
      if (!Number.isSafeInteger(previewLimit) || previewLimit < 1 || previewLimit > 10_000) {
        beginInvalidQuery(tabId, 'sql', invalidArgument('Preview limit must be between 1 and 10000')); return
      }
      if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
        beginInvalidQuery(tabId, 'sql', invalidArgument('Batch size must be between 1 and 5000')); return
      }
      await runQuery(tabId, 'sql', previewLimit, batchSize, (tab) => api.startQuery({ fileId: tab.fileId, sql, previewLimit, batchSize }))
    },
    async loadNextBatch(tabId) {
      const query = get().queriesByTab[tabId]
      if (!query?.queryId || query.loadingBatch || query.done || query.status !== 'running') return
      const { queryId, generation } = query
      set((state) => ({ queriesByTab: { ...state.queriesByTab, [tabId]: { ...query, loadingBatch: true } } }))
      try {
        const batch = await api.fetchQueryBatch(queryId)
        const current = get().queriesByTab[tabId]
        if (!current || current.generation !== generation || current.queryId !== queryId) return
        if (batch.queryId !== queryId || batch.rows.some((row) => row.length !== current.columns.length)) throw internalQueryError()
        const limit = queryLimits.get(tabId) ?? 10_000
        const available = Math.max(0, limit - current.rows.length)
        if (batch.rows.length > available || (batch.truncated && !batch.done)) throw internalQueryError()
        const appended = batch.rows.slice(0, available)
        const rows = [...current.rows, ...appended]
        const truncated = batch.truncated
        const done = batch.done
        set((state) => ({ queriesByTab: { ...state.queriesByTab, [tabId]: {
          ...current, rows, done, status: done ? 'done' : 'running', returnedRows: batch.returnedRows,
          elapsedMs: batch.elapsedMs, loadingBatch: false, truncated, stale: false,
        } } }))
      } catch (error) {
        const current = get().queriesByTab[tabId]
        if (!current || current.generation !== generation || current.queryId !== queryId) return
        set((state) => ({ queriesByTab: { ...state.queriesByTab, [tabId]: {
          ...current, status: 'error', loadingBatch: false, error: sanitized(error),
        } } }))
        try { await api.cancelQuery(queryId) } catch { /* best effort */ }
      }
    },
    async cancelQuery(tabId) {
      const query = get().queriesByTab[tabId]
      if (!query) return
      set((state) => ({ queriesByTab: { ...state.queriesByTab, [tabId]: {
        ...query, status: 'cancelled', done: true, loadingBatch: false, generation: query.generation + 1,
      } } }))
      if (query.queryId) { try { await api.cancelQuery(query.queryId) } catch { /* best effort */ } }
    },
    flushSave: saveNow,
    dispose() { disposed = true; if (saveTimer) clearTimeout(saveTimer); saveTimer = undefined },
  }))
  return store
}
