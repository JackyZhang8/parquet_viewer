import { createStore, type StoreApi } from 'zustand/vanilla'
import type {
  AppError, FileMetadata, SessionFilter, SessionSnapshot, SessionSort, SessionViewState,
} from '../domain/types'
import { isAppError } from '../domain/types'
import type { DesktopApi, OpenFileOutcome } from '../lib/tauri'

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

  const sanitized = (error: unknown): AppError => isAppError(error) ? error : {
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
    const remaining = state.tabs.filter((tab) => !ids.has(tab.id))
    let active = state.activeTabId
    if (active && ids.has(active)) {
      const activeIndex = state.tabs.findIndex((tab) => tab.id === active)
      const previous = remaining.filter((tab) => state.tabs.indexOf(tab) < activeIndex)
      active = remaining.find((tab) => state.tabs.indexOf(tab) > activeIndex)?.id ??
        previous[previous.length - 1]?.id ?? null
    }
    updateTabs(remaining, active)
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

  store = createStore<WorkspaceState>((set, get) => ({
    tabs: [], activeTabId: null, opening: 0, pathErrors: {}, hydrationState: 'idle', warning: null,
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
            for (let index = 0; index < available.length; index += 1) {
              const original = available[index]
              const outcome = outcomes[index] ?? { ok: false, error: sanitized(null) } as const
              const live = get().tabs.find((tab) => tab.id === original.id)
              if (!live) {
                if (outcome.ok && !get().tabs.some((tab) => tab.status === 'ready' && tab.fileId === outcome.metadata.fileId)) {
                  try { await api.closeFile(outcome.metadata.fileId) } catch (error) { get().reportError(`Close ${outcome.metadata.fileId}`, error) }
                }
                continue
              }
              if (outcome.ok) {
                set((state) => ({ tabs: state.tabs.map((tab) => tab.id === original.id ? { ...tab, fileId: outcome.metadata.fileId, path: outcome.metadata.path, metadata: outcome.metadata, status: 'ready', error: undefined } : tab) }))
              } else {
                set((state) => ({ tabs: state.tabs.map((tab) => tab.id === original.id ? { ...tab, status: 'error', error: outcome.error } : tab), pathErrors: { ...state.pathErrors, [original.path]: outcome.error } }))
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
    flushSave: saveNow,
    dispose() { disposed = true; if (saveTimer) clearTimeout(saveTimer); saveTimer = undefined },
  }))
  return store
}
