import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppError, FileMetadata, RestoredSession, SessionSnapshot } from '../domain/types'
import type { DesktopApi, OpenFileOutcome } from '../lib/tauri'
import { createWorkspaceStore } from './workspace'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const metadata = (fileId: string, path: string): FileMetadata => ({
  fileId,
  path,
  name: path.split('/').pop()!,
  sizeBytes: '1024',
  rowCount: '20',
  rowGroupCount: 1,
  columns: [],
})

const invalid: AppError = { code: 'INVALID_PARQUET', message: 'Not parquet', detail: null }

const emptyRestore = (): RestoredSession => ({
  snapshot: { version: 1, tabs: [], activeTabId: null },
  unavailableTabIds: [],
  warning: null,
})

const api = (overrides: Partial<DesktopApi> = {}): DesktopApi => ({
  openFiles: vi.fn(async (paths: string[]) => paths.map((path, i) => ({ ok: true, metadata: metadata(`f${i}`, path) }) as OpenFileOutcome)),
  closeFile: vi.fn(async () => undefined),
  loadSession: vi.fn(async () => emptyRestore()),
  saveSession: vi.fn(async () => undefined),
  pickParquetFiles: vi.fn(async () => null),
  onFileDrop: vi.fn(async () => () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
  ...overrides,
})

describe('workspace store', () => {
  beforeEach(() => vi.useRealTimers())

  it('adds ordered successful files while retaining a per-path error', async () => {
    const desktop = api({
      openFiles: vi.fn(async (): Promise<OpenFileOutcome[]> => [
        { ok: true, metadata: metadata('a', '/a.parquet') },
        { ok: false, error: invalid },
        { ok: true, metadata: metadata('c', '/c.parquet') },
      ]),
    })
    const store = createWorkspaceStore(desktop)

    await store.getState().openPaths(['/a.parquet', '/bad.txt', '/c.parquet'])

    expect(store.getState().tabs.map((tab) => tab.path)).toEqual(['/a.parquet', '/c.parquet'])
    expect(store.getState().pathErrors['/bad.txt']).toEqual(invalid)
    expect(store.getState().activeTabId).toBe(store.getState().tabs[0].id)
    store.getState().dispose()
  })

  it('deduplicates by authoritative backend file id and focuses the existing tab', async () => {
    const desktop = api({
      openFiles: vi.fn(async (paths: string[]) => paths.map((path): OpenFileOutcome => ({ ok: true, metadata: metadata('same', path) }))),
    })
    const store = createWorkspaceStore(desktop)
    await store.getState().openPaths(['/alias-a.parquet'])
    await store.getState().openPaths(['/alias-b.parquet'])

    expect(store.getState().tabs).toHaveLength(1)
    expect(store.getState().activeTabId).toBe(store.getState().tabs[0].id)
    store.getState().dispose()
  })

  it('closes active/others/right, reorders, and keeps independent drafts and view state', async () => {
    const desktop = api()
    const store = createWorkspaceStore(desktop)
    await store.getState().openPaths(['/a.parquet', '/b.parquet', '/c.parquet'])
    const [a, b, c] = store.getState().tabs
    store.getState().setSqlDraft(a.id, 'select a')
    store.getState().setSqlDraft(b.id, 'select b')
    store.getState().setViewState(a.id, { scrollTop: 42 })
    store.getState().reorderTabs(2, 0)
    expect(store.getState().tabs.map((tab) => tab.id)).toEqual([c.id, a.id, b.id])
    expect(store.getState().tabs.find((tab) => tab.id === a.id)?.viewState.scrollTop).toBe(42)
    expect(store.getState().tabs.find((tab) => tab.id === b.id)?.sqlDraft).toBe('select b')

    store.getState().activateTab(a.id)
    await store.getState().closeRight(a.id)
    expect(store.getState().tabs.map((tab) => tab.id)).toEqual([c.id, a.id])
    await store.getState().closeOthers(c.id)
    expect(store.getState().tabs.map((tab) => tab.id)).toEqual([c.id])
    await store.getState().closeTab(c.id)
    expect(store.getState().activeTabId).toBeNull()
    expect(desktop.closeFile).toHaveBeenCalledTimes(3)
    store.getState().dispose()
  })

  it('hydrates persisted order/state, retains unavailable tabs, and reuses one when reopened', async () => {
    const snapshot: SessionSnapshot = {
      version: 1,
      activeTabId: 'two',
      tabs: [
        { id: 'one', fileId: 'old-one', path: '/one.parquet', sqlDraft: 'one sql', filters: [], sorts: [], viewState: { scrollTop: 1, scrollLeft: 2, sidebarWidth: 240, editorHeight: 180 } },
        { id: 'two', fileId: 'old-two', path: '/missing.parquet', sqlDraft: 'two sql', filters: [], sorts: [], viewState: { scrollTop: 3, scrollLeft: 4, sidebarWidth: 250, editorHeight: 190 } },
      ],
    }
    const desktop = api({
      loadSession: vi.fn(async () => ({ snapshot, unavailableTabIds: ['two'], warning: 'Some files are unavailable' })),
      openFiles: vi.fn(async (): Promise<OpenFileOutcome[]> => [{ ok: true, metadata: metadata('new-one', '/one.parquet') }]),
    })
    const store = createWorkspaceStore(desktop)
    await store.getState().hydrate()

    expect(store.getState().tabs.map((tab) => [tab.id, tab.status])).toEqual([['one', 'ready'], ['two', 'unavailable']])
    expect(store.getState().activeTabId).toBe('two')
    expect(store.getState().warning).toBe('Some files are unavailable')

    vi.mocked(desktop.openFiles).mockResolvedValueOnce([{ ok: true, metadata: metadata('new-two', '/missing.parquet') }])
    await store.getState().openPaths(['/missing.parquet'])
    expect(store.getState().tabs).toHaveLength(2)
    expect(store.getState().tabs[1]).toMatchObject({ id: 'two', fileId: 'new-two', status: 'ready', sqlDraft: 'two sql' })
    store.getState().dispose()
  })

  it('hydrates only once and saves a serializable snapshot without metadata or transient state', async () => {
    vi.useFakeTimers()
    const desktop = api()
    const store = createWorkspaceStore(desktop, { saveDelayMs: 300 })
    await store.getState().hydrate()
    await store.getState().hydrate()
    expect(desktop.loadSession).toHaveBeenCalledTimes(1)
    await store.getState().openPaths(['/a.parquet'])
    expect(desktop.saveSession).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(300))
    expect(desktop.saveSession).toHaveBeenCalledTimes(1)
    const saved = vi.mocked(desktop.saveSession).mock.calls[0][0]
    expect(saved.tabs[0]).not.toHaveProperty('metadata')
    expect(saved.tabs[0]).not.toHaveProperty('status')
    expect(saved.tabs[0].fileId).toBe('f0')
    store.getState().dispose()
  })

  it('waits for hydration before opening user paths and preserves exact path text', async () => {
    const loading = deferred<RestoredSession>()
    const desktop = api({ loadSession: vi.fn(() => loading.promise) })
    const store = createWorkspaceStore(desktop)
    const hydrate = store.getState().hydrate()
    const opening = store.getState().openPaths([' /new.parquet '])
    expect(desktop.openFiles).not.toHaveBeenCalled()
    loading.resolve({
      snapshot: { version: 1, activeTabId: 'saved', tabs: [{ id: 'saved', fileId: 'old', path: '/saved.parquet', sqlDraft: '', filters: [], sorts: [], viewState: { scrollTop: 0, scrollLeft: 0, sidebarWidth: 200, editorHeight: 100 } }] },
      unavailableTabIds: ['saved'], warning: null,
    })
    await hydrate
    await opening
    expect(desktop.openFiles).toHaveBeenCalledWith([' /new.parquet '])
    expect(store.getState().tabs.map((tab) => tab.id)).toContain('saved')
    expect(store.getState().tabs.some((tab) => tab.path === ' /new.parquet ')).toBe(true)
  })

  it('closes a restored loading tab without stale close and cleans the reopened orphan', async () => {
    const reopening = deferred<OpenFileOutcome[]>()
    const desktop = api({
      loadSession: vi.fn(async () => ({
        snapshot: { version: 1, activeTabId: 'saved', tabs: [{ id: 'saved', fileId: 'stale', path: '/saved.parquet', sqlDraft: '', filters: [], sorts: [], viewState: { scrollTop: 0, scrollLeft: 0, sidebarWidth: 200, editorHeight: 100 } }] },
        unavailableTabIds: [], warning: null,
      })),
      openFiles: vi.fn(() => reopening.promise),
    })
    const store = createWorkspaceStore(desktop)
    const hydration = store.getState().hydrate()
    await vi.waitFor(() => expect(store.getState().tabs[0]?.status).toBe('loading'))
    await store.getState().closeTab('saved')
    expect(desktop.closeFile).not.toHaveBeenCalled()
    reopening.resolve([{ ok: true, metadata: metadata('new-id', '/saved.parquet') }])
    await hydration
    expect(store.getState().tabs).toHaveLength(0)
    expect(desktop.closeFile).toHaveBeenCalledWith('new-id')
  })

  it('preserves hydrate error details and reuses the tab on successful retry', async () => {
    const desktop = api({
      loadSession: vi.fn(async () => ({
        snapshot: { version: 1, activeTabId: 'saved', tabs: [{ id: 'saved', fileId: 'stale', path: '/saved.parquet', sqlDraft: 'draft', filters: [], sorts: [], viewState: { scrollTop: 7, scrollLeft: 0, sidebarWidth: 200, editorHeight: 100 } }] },
        unavailableTabIds: [], warning: null,
      })),
      openFiles: vi.fn(async (): Promise<OpenFileOutcome[]> => [{ ok: false, error: invalid }]),
    })
    const store = createWorkspaceStore(desktop)
    await store.getState().hydrate()
    expect(store.getState().tabs[0]).toMatchObject({ id: 'saved', status: 'error', error: invalid })
    expect(store.getState().pathErrors['/saved.parquet']).toEqual(invalid)
    vi.mocked(desktop.openFiles).mockResolvedValueOnce([{ ok: true, metadata: metadata('new', '/saved.parquet') }])
    await store.getState().openPaths(['/saved.parquet'])
    expect(store.getState().tabs).toHaveLength(1)
    expect(store.getState().tabs[0]).toMatchObject({ id: 'saved', status: 'ready', sqlDraft: 'draft', fileId: 'new' })
    expect(store.getState().tabs[0].error).toBeUndefined()
  })
})
