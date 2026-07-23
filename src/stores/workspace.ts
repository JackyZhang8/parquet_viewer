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
  hydrate(restoreTabs?: boolean): Promise<void>
  activateTab(id: string): void
  closeTab(id: string): Promise<void>
  closeOthers(id: string): Promise<void>
  closeRight(id: string): Promise<void>
  reloadTab(id: string): Promise<void>
  reorderTabs(from: number, to: number): void
  setSqlDraft(id: string, sqlDraft: string): void
  setFilters(id: string, filters: SessionFilter[]): void
  setSorts(id: string, sorts: SessionSort[]): void
  setViewState(id: string, viewState: Partial<SessionViewState>): void
  runFilterQuery(tabId: string, request: FilterQueryRequest, batchSize?: number): Promise<void>
  runSqlQuery(tabId: string, sql: string, previewLimit?: number, batchSize?: number): Promise<void>
  loadNextBatch(tabId: string): Promise<void>
  cancelQuery(tabId: string): Promise<void>
  flushSave(): Promise<void>
  dispose(): void
}

const defaultViewState = (): SessionViewState => ({
  scrollTop: 0, scrollLeft: 0, sidebarWidth: 260, editorHeight: 180,
})

const MAX_U32 = 0xffff_ffff
const MAX_U16 = 0xffff

const persistUnsigned = (value: number, max: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : fallback

const persistedViewState = (viewState: SessionViewState): SessionViewState => ({
  scrollTop: persistUnsigned(viewState.scrollTop, MAX_U32, 0),
  scrollLeft: persistUnsigned(viewState.scrollLeft, MAX_U32, 0),
  sidebarWidth: persistUnsigned(viewState.sidebarWidth, MAX_U16, 260),
  editorHeight: persistUnsigned(viewState.editorHeight, MAX_U16, 180),
})

let nextTab = 0
const tabId = () => `tab-${Date.now().toString(36)}-${(++nextTab).toString(36)}`

const snapshot = (state: WorkspaceState): SessionSnapshot => ({
  version: 1,
  tabs: state.tabs.map(({ id, fileId, path, sqlDraft, filters, sorts, viewState }) => ({
    id, fileId, path, sqlDraft, filters, sorts, viewState: persistedViewState(viewState),
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

  const clearError = (key: string) => {
    const pathErrors = store.getState().pathErrors
    if (!(key in pathErrors)) return
    const next = { ...pathErrors }
    delete next[key]
    store.setState({ pathErrors: next })
  }

  const saveNow = async () => {
    if (disposed || store.getState().hydrationState !== 'ready') return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = undefined
    try { await api.saveSession(snapshot(store.getState())); clearError('Session save') } catch (error) { store.getState().reportError('Session save', error) }
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
  const beginInvalidQuery = (tabId: string, source: 'filter' | 'sql', error: AppError, submittedSql?: string) => {
    const previous = store.getState().queriesByTab[tabId] ?? idleQueryState()
    if (previous.queryId) void api.cancelQuery(previous.queryId).catch(() => undefined)
    const preserved = previous.hasSuccessfulResult ? previous : idleQueryState(previous.generation)
    store.setState((state) => ({ queriesByTab: { ...state.queriesByTab, [tabId]: {
      ...preserved, status: 'error', queryId: undefined, loadingBatch: false, done: false,
      stale: previous.hasSuccessfulResult, generation: previous.generation + 1, error, source, submittedSql,
    } } }))
  }
  const runQuery = async (
    tabId: string, source: 'filter' | 'sql', previewLimit: number, batchSize: number,
    start: (tab: WorkspaceTab) => Promise<{ queryId: string; columns: FileMetadata['columns'] }>,
    submittedSql?: string,
    submittedFilter?: FilterQueryRequest,
  ) => {
    const tab = store.getState().tabs.find((item) => item.id === tabId)
    if (!tab || tab.status !== 'ready' || store.getState().activeTabId !== tabId) return
    const previous = store.getState().queriesByTab[tabId] ?? idleQueryState()
    const generation = previous.generation + 1
    if (previous.queryId) void api.cancelQuery(previous.queryId).catch(() => undefined)
    const preserved = previous.hasSuccessfulResult ? previous : idleQueryState(previous.generation)
    store.setState((state) => ({ queriesByTab: { ...state.queriesByTab, [tabId]: {
      ...preserved, status: 'queued', error: undefined, loadingBatch: false, done: false,
      stale: previous.hasSuccessfulResult, generation, queryId: undefined, source, submittedSql, submittedFilter,
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
        ...idleQueryState(generation), status: 'running', queryId: started.queryId, columns: started.columns, source, submittedSql, submittedFilter,
      } } }))
      await store.getState().loadNextBatch(tabId)
    } catch (error) {
      const current = store.getState().queriesByTab[tabId]
      if (!current || current.generation !== generation) return
      store.setState((state) => ({ queriesByTab: { ...state.queriesByTab, [tabId]: {
        ...current, status: 'error', loadingBatch: false, stale: current.hasSuccessfulResult, error: sanitized(error),
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
    async hydrate(restoreTabs = true) {
      if (get().hydrationState === 'ready') return
      if (hydrating) return hydrating
      if (!restoreTabs) {
        set({ hydrationState: 'ready' })
        hydrating = Promise.resolve()
        return hydrating
      }
      set({ hydrationState: 'loading' })
      hydrating = (async () => {
        try {
          const restored = await api.loadSession()
          const unavailable = new Set(restored.unavailableTabIds)
          const tabs: WorkspaceTab[] = restored.snapshot.tabs.map((tab) => ({ ...tab, metadata: undefined, status: unavailable.has(tab.id) ? 'unavailable' : 'loading' }))
          set({ tabs, activeTabId: restored.snapshot.activeTabId, warning: restored.warning })
          const available = tabs.filter((tab) => !unavailable.has(tab.id))
          if (available.length) {
            const returnedIds = new Set<string>()
            const openRestored = async (original: WorkspaceTab) => {
              let outcome: OpenFileOutcome
              try {
                outcome = (await api.openFiles([original.path]))[0] ?? { ok: false, error: sanitized(null) }
              } catch (error) { outcome = { ok: false, error: sanitized(error) } }
              const current = get()
              const liveOriginal = current.tabs.find((tab) => tab.id === original.id)
              if (!outcome.ok) {
                if (!liveOriginal) return
                set({
                  tabs: current.tabs.map((tab) => tab.id === original.id ? { ...tab, status: 'error', error: outcome.error } : tab),
                  pathErrors: { ...current.pathErrors, [original.path]: outcome.error },
                })
                return
              }
              returnedIds.add(outcome.metadata.fileId)
              if (!liveOriginal) return
              const duplicate = current.tabs.find((tab) => tab.id !== original.id && tab.status === 'ready' && tab.fileId === outcome.metadata.fileId)
              const retainOriginal = !duplicate || current.activeTabId === original.id
              const retainedId = retainOriginal ? original.id : duplicate.id
              const pathErrors = { ...current.pathErrors }
              delete pathErrors[original.path]
              const nextTabs = current.tabs
                .filter((tab) => !duplicate || tab.id !== (retainOriginal ? duplicate.id : original.id))
                .map((tab) => tab.id === retainedId ? {
                  ...tab, fileId: outcome.metadata.fileId, path: outcome.metadata.path, metadata: outcome.metadata,
                  status: 'ready' as const, error: undefined,
                } : tab)
              set({ tabs: nextTabs, pathErrors })
            }
            const active = available.find((tab) => tab.id === get().activeTabId)
            if (active) await openRestored(active)
            const background = available.filter((tab) => tab.id !== active?.id)
            let next = 0
            const worker = async () => {
              while (next < background.length) {
                const original = background[next++]
                await openRestored(original)
              }
            }
            await Promise.all(Array.from({ length: Math.min(2, background.length) }, worker))
            const liveTabs = get().tabs
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
    async reloadTab(id) {
      const tab = get().tabs.find((item) => item.id === id)
      if (!tab || tab.status !== 'ready') return
      await api.cancelFileQueries(tab.fileId)
      const metadata = await api.reloadFile(tab.fileId)
      const current = get()
      if (!current.tabs.some((item) => item.id === id)) return
      const queriesByTab = { ...current.queriesByTab }
      delete queriesByTab[id]; queryLimits.delete(id)
      set({
        tabs: current.tabs.map((item) => item.id === id ? { ...item, metadata, path: metadata.path, status: 'ready', error: undefined } : item),
        queriesByTab,
      })
      scheduleSave()
    },
    reorderTabs(from, to) { const tabs = [...get().tabs]; if (from < 0 || to < 0 || from >= tabs.length || to >= tabs.length) return; const [tab] = tabs.splice(from, 1); tabs.splice(to, 0, tab); updateTabs(tabs) },
    setSqlDraft(id, sqlDraft) { updateTabs(get().tabs.map((tab) => tab.id === id ? { ...tab, sqlDraft } : tab)) },
    setFilters(id, filters) { updateTabs(get().tabs.map((tab) => tab.id === id ? { ...tab, filters } : tab)) },
    setSorts(id, sorts) { updateTabs(get().tabs.map((tab) => tab.id === id ? { ...tab, sorts } : tab)) },
    setViewState(id, viewState) { updateTabs(get().tabs.map((tab) => tab.id === id ? { ...tab, viewState: { ...tab.viewState, ...viewState } } : tab)) },
    async runFilterQuery(tabId, request, batchSize = 500) {
      if (!canRunQuery(tabId)) return
      if (!Number.isSafeInteger(request.previewLimit) || request.previewLimit < 1 || request.previewLimit > 100_000) {
        beginInvalidQuery(tabId, 'filter', invalidArgument('Preview limit must be between 1 and 100000'))
        return
      }
      if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
        beginInvalidQuery(tabId, 'filter', invalidArgument('Batch size must be between 1 and 5000'))
        return
      }
      await runQuery(tabId, 'filter', request.previewLimit, batchSize, (tab) => api.startFilterQuery({ fileId: tab.fileId, query: request, batchSize }), undefined, request)
    },
    async runSqlQuery(tabId, sql, previewLimit = 10_000, batchSize = 500) {
      if (!canRunQuery(tabId)) return
      if (sql.trim().length === 0) { beginInvalidQuery(tabId, 'sql', invalidArgument('SQL query must not be empty'), sql); return }
      if (utf8.encode(sql).length > 256 * 1024) { beginInvalidQuery(tabId, 'sql', invalidArgument('SQL query must not exceed 256 KiB'), sql); return }
      if (!Number.isSafeInteger(previewLimit) || previewLimit < 1 || previewLimit > 100_000) {
        beginInvalidQuery(tabId, 'sql', invalidArgument('Preview limit must be between 1 and 100000'), sql); return
      }
      if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
        beginInvalidQuery(tabId, 'sql', invalidArgument('Batch size must be between 1 and 5000'), sql); return
      }
      await runQuery(tabId, 'sql', previewLimit, batchSize, (tab) => api.startQuery({ fileId: tab.fileId, sql, previewLimit, batchSize }), sql)
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
          hasSuccessfulResult: done,
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
      else if (query.status === 'queued') {
        const tab = get().tabs.find((item) => item.id === tabId)
        if (tab?.status === 'ready') { try { await api.cancelFileQueries(tab.fileId) } catch { /* best effort */ } }
      }
    },
    flushSave: saveNow,
    dispose() { disposed = true; if (saveTimer) clearTimeout(saveTimer); saveTimer = undefined },
  }))
  return store
}
