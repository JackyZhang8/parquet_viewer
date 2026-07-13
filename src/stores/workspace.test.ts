import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppError, FileMetadata, QueryBatch, QueryStarted, RestoredSession, SessionSnapshot } from '../domain/types'
import type { DesktopApi, OpenFileOutcome } from '../lib/tauri'
import { createWorkspaceStore } from './workspace'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
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
  startFilterQuery: vi.fn(async (): Promise<QueryStarted> => ({ queryId: 'q', columns: [] })),
  startQuery: vi.fn(async (): Promise<QueryStarted> => ({ queryId: 'q', columns: [] })),
  fetchQueryBatch: vi.fn(async (): Promise<QueryBatch> => ({ queryId: 'q', rows: [], done: true, truncated: false, returnedRows: '0', elapsedMs: '0' })),
  cancelQuery: vi.fn(async () => undefined),
  startExport: vi.fn(async () => ({ exportId: 'export-1' })),
  cancelExport: vi.fn(async () => undefined),
  onExportProgress: vi.fn(async () => () => undefined),
  pickCsvDestination: vi.fn(async () => null),
  confirmExportOverwrite: vi.fn(async () => false),
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

  const duplicateRestore = (activeTabId: string) => ({
    snapshot: { version: 1, activeTabId, tabs: [
      { id: 'first', fileId: 'old-1', path: '/alias-one.parquet', sqlDraft: 'first draft', filters: [], sorts: [], viewState: { scrollTop: 1, scrollLeft: 0, sidebarWidth: 200, editorHeight: 100 } },
      { id: 'second', fileId: 'old-2', path: '/alias-two.parquet', sqlDraft: 'second draft', filters: [], sorts: [], viewState: { scrollTop: 2, scrollLeft: 0, sidebarWidth: 210, editorHeight: 110 } },
    ] }, unavailableTabIds: [], warning: null,
  } satisfies RestoredSession)

  it('deduplicates restored aliases by canonical file id and prefers the active tab state', async () => {
    const reopening = deferred<OpenFileOutcome[]>()
    const desktop = api({ loadSession: vi.fn(async () => duplicateRestore('second')), openFiles: vi.fn(() => reopening.promise) })
    const store = createWorkspaceStore(desktop)
    const hydration = store.getState().hydrate()
    await vi.waitFor(() => expect(store.getState().tabs).toHaveLength(2))
    reopening.resolve([
      { ok: true, metadata: metadata('shared', '/canonical.parquet') },
      { ok: true, metadata: metadata('shared', '/canonical.parquet') },
    ])
    await hydration
    expect(store.getState().tabs).toHaveLength(1)
    expect(store.getState().tabs[0]).toMatchObject({ id: 'second', fileId: 'shared', sqlDraft: 'second draft' })
    expect(store.getState().activeTabId).toBe('second')
    expect(desktop.closeFile).not.toHaveBeenCalled()
  })

  it('keeps a shared restored handle when one alias closes during reopen', async () => {
    const reopening = deferred<OpenFileOutcome[]>()
    const desktop = api({ loadSession: vi.fn(async () => duplicateRestore('first')), openFiles: vi.fn(() => reopening.promise) })
    const store = createWorkspaceStore(desktop)
    const hydration = store.getState().hydrate()
    await vi.waitFor(() => expect(store.getState().tabs).toHaveLength(2))
    await store.getState().closeTab('first')
    reopening.resolve([
      { ok: true, metadata: metadata('shared', '/canonical.parquet') },
      { ok: true, metadata: metadata('shared', '/canonical.parquet') },
    ])
    await hydration
    expect(store.getState().tabs).toHaveLength(1)
    expect(store.getState().tabs[0]).toMatchObject({ id: 'second', fileId: 'shared', status: 'ready' })
    expect(desktop.closeFile).not.toHaveBeenCalled()
  })

  it('closes a shared reopened handle once when all restored owners close', async () => {
    const reopening = deferred<OpenFileOutcome[]>()
    const desktop = api({ loadSession: vi.fn(async () => duplicateRestore('first')), openFiles: vi.fn(() => reopening.promise) })
    const store = createWorkspaceStore(desktop)
    const hydration = store.getState().hydrate()
    await vi.waitFor(() => expect(store.getState().tabs).toHaveLength(2))
    await store.getState().closeTab('first')
    await store.getState().closeTab('second')
    reopening.resolve([
      { ok: true, metadata: metadata('shared', '/canonical.parquet') },
      { ok: true, metadata: metadata('shared', '/canonical.parquet') },
    ])
    await hydration
    expect(store.getState().tabs).toHaveLength(0)
    expect(desktop.closeFile).toHaveBeenCalledTimes(1)
    expect(desktop.closeFile).toHaveBeenCalledWith('shared')
  })

  it('runs a filter with the authoritative file id and fetches the first batch', async () => {
    const desktop = api({
      startFilterQuery: vi.fn(async () => ({ queryId: 'q1', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })),
      fetchQueryBatch: vi.fn(async () => ({ queryId: 'q1', rows: [[1], [2], [3]], done: false, truncated: false, returnedRows: '3', elapsedMs: '4' })),
    })
    const store = createWorkspaceStore(desktop)
    await store.getState().openPaths(['/a.parquet'])
    const tab = store.getState().tabs[0]
    await store.getState().runFilterQuery(tab.id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 10 })

    expect(desktop.startFilterQuery).toHaveBeenCalledWith({ fileId: tab.fileId, query: { selectedColumns: [], filters: [], sorts: [], previewLimit: 10 }, batchSize: 500 })
    expect(store.getState().queriesByTab[tab.id]).toMatchObject({ status: 'running', queryId: 'q1', rows: [[1], [2], [3]], returnedRows: '3', loadingBatch: false })
  })

  it('runs SQL with the exact bounded request and replaces stale data after start succeeds', async () => {
    const desktop = api({
      startQuery: vi.fn(async () => ({ queryId: 'sql', columns: [{ name: 'name', logicalType: 'VARCHAR', nullable: true }] })),
      fetchQueryBatch: vi.fn(async () => ({ queryId: 'sql', rows: [['new']], done: true, truncated: false, returnedRows: '1', elapsedMs: '3' })),
    })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    await store.getState().runSqlQuery(id, ' SELECT name FROM data ', 123, 45)
    expect(desktop.startQuery).toHaveBeenCalledWith({ fileId: 'f0', sql: ' SELECT name FROM data ', previewLimit: 123, batchSize: 45 })
    expect(store.getState().queriesByTab[id]).toMatchObject({ status: 'done', columns: [{ name: 'name' }], rows: [['new']], stale: false })
  })

  it('preserves last successful rows as stale when a replacement SQL start fails', async () => {
    const desktop = api({
      startQuery: vi.fn().mockResolvedValueOnce({ queryId: 'ok', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })
        .mockRejectedValueOnce({ code: 'SQL_ERROR', message: 'Parser Error at line 2, column 7', detail: null }),
      fetchQueryBatch: vi.fn(async () => ({ queryId: 'ok', rows: [[7]], done: true, truncated: false, returnedRows: '1', elapsedMs: '2' })),
    })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    await store.getState().runSqlQuery(id, 'SELECT id FROM data')
    await store.getState().runSqlQuery(id, 'SELECT nope FROM data')
    expect(store.getState().queriesByTab[id]).toMatchObject({ status: 'error', columns: [{ name: 'id' }], rows: [[7]], stale: true, error: { code: 'SQL_ERROR' } })
  })

  it('treats a completed zero-row result as successful when a replacement fails', async () => {
    const desktop = api({
      startQuery: vi.fn().mockResolvedValueOnce({ queryId: 'empty', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })
        .mockRejectedValueOnce({ code: 'SQL_ERROR', message: 'bad', detail: null }),
      fetchQueryBatch: vi.fn(async () => ({ queryId: 'empty', rows: [], done: true, truncated: false, returnedRows: '0', elapsedMs: '1' })),
    })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    await store.getState().runSqlQuery(id, 'SELECT id FROM data WHERE false')
    expect(store.getState().queriesByTab[id]).toMatchObject({ status: 'done', rows: [], hasSuccessfulResult: true })
    await store.getState().runSqlQuery(id, 'SELECT nope FROM data')
    expect(store.getState().queriesByTab[id]).toMatchObject({ status: 'error', rows: [], stale: true, hasSuccessfulResult: true })
  })

  it('does not preserve partial running rows as a successful result on replacement failure', async () => {
    const desktop = api({
      startQuery: vi.fn().mockResolvedValueOnce({ queryId: 'partial', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })
        .mockRejectedValueOnce({ code: 'SQL_ERROR', message: 'bad', detail: null }),
      fetchQueryBatch: vi.fn(async () => ({ queryId: 'partial', rows: [[1]], done: false, truncated: false, returnedRows: '1', elapsedMs: '1' })),
    })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    await store.getState().runSqlQuery(id, 'SELECT id FROM data')
    expect(store.getState().queriesByTab[id]).toMatchObject({ status: 'running', rows: [[1]], hasSuccessfulResult: false })
    await store.getState().runSqlQuery(id, 'SELECT nope FROM data')
    expect(store.getState().queriesByTab[id]).toMatchObject({ status: 'error', rows: [], stale: false, hasSuccessfulResult: false })
  })

  it('records the exact submitted SQL revision on SQL errors', async () => {
    const desktop = api({ startQuery: vi.fn(async () => { throw { code: 'SQL_ERROR', message: 'bad', detail: null } }) })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    await store.getState().runSqlQuery(id, 'SELECT submitted FROM data')
    expect(store.getState().queriesByTab[id]).toMatchObject({ source: 'sql', submittedSql: 'SELECT submitted FROM data', status: 'error' })
  })

  it.each([
    ['', /empty/i], ['   ', /empty/i], ['x'.repeat(262_145), /256/],
  ])('rejects invalid SQL locally: %s', async (sql, message) => {
    const desktop = api(); const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    await store.getState().runSqlQuery(id, sql)
    expect(desktop.startQuery).not.toHaveBeenCalled()
    expect(store.getState().queriesByTab[id]).toMatchObject({ status: 'error', stale: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringMatching(message) } })
  })

  it('validates SQL preview and batch limits locally', async () => {
    const desktop = api(); const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    await store.getState().runSqlQuery(id, 'SELECT 1', 0, 500)
    await store.getState().runSqlQuery(id, 'SELECT 1', 1, 5001)
    expect(desktop.startQuery).not.toHaveBeenCalled()
    expect(store.getState().queriesByTab[id].error).toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('ignores even invalid query starts from an inactive tab callback', async () => {
    const desktop = api(); const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a', '/b']); const [a, b] = store.getState().tabs
    store.getState().activateTab(b.id)
    await store.getState().runSqlQuery(a.id, '')
    await store.getState().runFilterQuery(a.id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 0 })
    expect(store.getState().queriesByTab[a.id]).toBeUndefined()
    expect(desktop.startQuery).not.toHaveBeenCalled()
    expect(desktop.startFilterQuery).not.toHaveBeenCalled()
  })

  it('cancels and isolates late SQL/filter replacements through one generation lifecycle', async () => {
    const old = deferred<QueryStarted>()
    const desktop = api({
      startQuery: vi.fn(() => old.promise),
      startFilterQuery: vi.fn(async () => ({ queryId: 'filter', columns: [] })),
      fetchQueryBatch: vi.fn(async (queryId) => ({ queryId, rows: [], done: true, truncated: false, returnedRows: '0', elapsedMs: '1' })),
    })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    const sql = store.getState().runSqlQuery(id, 'SELECT * FROM data')
    await store.getState().runFilterQuery(id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 5 })
    old.resolve({ queryId: 'late-sql', columns: [] }); await sql
    expect(store.getState().queriesByTab[id]).toMatchObject({ queryId: 'filter', status: 'done' })
    expect(desktop.cancelQuery).toHaveBeenCalledWith('late-sql')
  })

  it('reports queued while awaiting backend query admission', async () => {
    const starting = deferred<QueryStarted>()
    const desktop = api({ startFilterQuery: vi.fn(() => starting.promise) })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    const run = store.getState().runFilterQuery(id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 5 })
    expect(store.getState().queriesByTab[id].status).toBe('queued')
    starting.resolve({ queryId: 'q', columns: [] }); await run
    expect(store.getState().queriesByTab[id].status).toBe('done')
  })

  it('rejects preview limits above the UI cap without calling the backend', async () => {
    const desktop = api(); const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    await store.getState().runFilterQuery(id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 10001 })
    expect(desktop.startFilterQuery).not.toHaveBeenCalled()
    expect(store.getState().queriesByTab[id]).toMatchObject({ status: 'error', error: { code: 'INVALID_ARGUMENT', message: expect.stringMatching(/10000/) } })
  })

  it('uses the backend truncation signal instead of row-count heuristics', async () => {
    const desktop = api({
      startFilterQuery: vi.fn(async () => ({ queryId: 'q', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })),
      fetchQueryBatch: vi.fn(async () => ({ queryId: 'q', rows: [[1], [2]], done: true, truncated: true, returnedRows: '2', elapsedMs: '1' })),
    })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    await store.getState().runFilterQuery(id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 10 })
    expect(store.getState().queriesByTab[id]).toMatchObject({ status: 'done', rows: [[1], [2]], truncated: true })
  })

  it('appends ordered batches, handles a final empty batch, and coalesces duplicate loads', async () => {
    const pending = deferred<QueryBatch>()
    const desktop = api({
      startFilterQuery: vi.fn(async () => ({ queryId: 'q1', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })),
      fetchQueryBatch: vi.fn()
        .mockResolvedValueOnce({ queryId: 'q1', rows: [[1], [2], [3]], done: false, truncated: false, returnedRows: '3', elapsedMs: '1' })
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValueOnce({ queryId: 'q1', rows: [[7], [8], [9]], done: false, truncated: false, returnedRows: '9', elapsedMs: '3' })
        .mockResolvedValueOnce({ queryId: 'q1', rows: [[10]], done: false, truncated: false, returnedRows: '10', elapsedMs: '4' })
        .mockResolvedValueOnce({ queryId: 'q1', rows: [], done: true, truncated: false, returnedRows: '10', elapsedMs: '5' }),
    })
    const store = createWorkspaceStore(desktop)
    await store.getState().openPaths(['/a.parquet']); const id = store.getState().tabs[0].id
    await store.getState().runFilterQuery(id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 20 })
    const one = store.getState().loadNextBatch(id); const two = store.getState().loadNextBatch(id)
    expect(desktop.fetchQueryBatch).toHaveBeenCalledTimes(2)
    pending.resolve({ queryId: 'q1', rows: [[4], [5], [6]], done: false, truncated: false, returnedRows: '6', elapsedMs: '2' })
    await Promise.all([one, two]); await store.getState().loadNextBatch(id); await store.getState().loadNextBatch(id); await store.getState().loadNextBatch(id)
    expect(store.getState().queriesByTab[id]).toMatchObject({ status: 'done', rows: [[1], [2], [3], [4], [5], [6], [7], [8], [9], [10]], done: true, returnedRows: '10' })
  })

  it('rejects backend rows beyond the preview cap and cancels malformed work', async () => {
    const desktop = api({
      startFilterQuery: vi.fn(async () => ({ queryId: 'q1', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })),
      fetchQueryBatch: vi.fn(async () => ({ queryId: 'q1', rows: [[1], [2], [3]], done: false, truncated: false, returnedRows: '3', elapsedMs: '1' })),
    })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    await store.getState().runFilterQuery(id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 2 })
    expect(store.getState().queriesByTab[id]).toMatchObject({ status: 'error', rows: [], error: { code: 'INTERNAL_ERROR' } })
    expect(desktop.cancelQuery).toHaveBeenCalledWith('q1')
  })

  it('ignores and cancels late old starts after replacement', async () => {
    const old = deferred<QueryStarted>()
    const desktop = api({
      startFilterQuery: vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValueOnce({ queryId: 'new', columns: [] }),
      fetchQueryBatch: vi.fn(async (queryId) => ({ queryId, rows: [], done: true, truncated: false, returnedRows: '0', elapsedMs: '1' })),
    })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    const first = store.getState().runFilterQuery(id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 5 })
    const second = store.getState().runFilterQuery(id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 5 })
    await second; old.resolve({ queryId: 'old', columns: [] }); await first
    expect(store.getState().queriesByTab[id]).toMatchObject({ queryId: 'new', status: 'done' })
    expect(desktop.cancelQuery).toHaveBeenCalledWith('old')
  })

  it('ignores a late old fetch after a replacement query completes', async () => {
    const oldBatch = deferred<QueryBatch>()
    const desktop = api({
      startFilterQuery: vi.fn().mockResolvedValueOnce({ queryId: 'old', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] }).mockResolvedValueOnce({ queryId: 'new', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] }),
      fetchQueryBatch: vi.fn().mockImplementationOnce(() => oldBatch.promise).mockResolvedValueOnce({ queryId: 'new', rows: [['new row']], done: true, truncated: false, returnedRows: '1', elapsedMs: '2' }),
    })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    const first = store.getState().runFilterQuery(id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 5 })
    await vi.waitFor(() => expect(store.getState().queriesByTab[id]?.loadingBatch).toBe(true))
    const second = store.getState().runFilterQuery(id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 5 })
    await second; oldBatch.resolve({ queryId: 'old', rows: [['old row']], done: true, truncated: false, returnedRows: '1', elapsedMs: '50' }); await first
    expect(store.getState().queriesByTab[id]).toMatchObject({ queryId: 'new', rows: [['new row']], status: 'done' })
    expect(desktop.cancelQuery).toHaveBeenCalledWith('old')
  })

  it('sanitizes malformed row widths, exposes the error, and cancels the query', async () => {
    const desktop = api({
      startFilterQuery: vi.fn(async () => ({ queryId: 'q1', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })),
      fetchQueryBatch: vi.fn(async () => ({ queryId: 'q1', rows: [[1, 2]], done: false, truncated: false, returnedRows: '1', elapsedMs: '1' })),
    })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a']); const id = store.getState().tabs[0].id
    await store.getState().runFilterQuery(id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 5 })
    expect(store.getState().queriesByTab[id]).toMatchObject({ status: 'error', error: { code: 'INTERNAL_ERROR' }, rows: [] })
    expect(desktop.cancelQuery).toHaveBeenCalledWith('q1')
  })

  it('cancels and removes per-tab transient query state when closing', async () => {
    const desktop = api({
      startFilterQuery: vi.fn(async () => ({ queryId: 'q1', columns: [] })),
      fetchQueryBatch: vi.fn(async () => ({ queryId: 'q1', rows: [], done: false, truncated: false, returnedRows: '0', elapsedMs: '1' })),
    })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a', '/b']); const [a, b] = store.getState().tabs
    await store.getState().runFilterQuery(a.id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 5 })
    await store.getState().cancelQuery(a.id)
    expect(store.getState().queriesByTab[a.id].status).toBe('cancelled')
    await store.getState().closeTab(a.id)
    expect(store.getState().queriesByTab[a.id]).toBeUndefined()
    expect(store.getState().queriesByTab[b.id]).toBeUndefined()
    expect(desktop.cancelQuery).toHaveBeenCalledWith('q1')
  })

  it('keeps query state isolated and excludes every transient field from saves', async () => {
    const desktop = api({
      startFilterQuery: vi.fn(async ({ fileId }) => ({ queryId: `q-${fileId}`, columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })),
      fetchQueryBatch: vi.fn(async (queryId) => ({ queryId, rows: [[queryId]], done: true, truncated: false, returnedRows: '1', elapsedMs: '1' })),
    })
    const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/a', '/b']); const [a, b] = store.getState().tabs
    await store.getState().runFilterQuery(a.id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 5 })
    store.getState().activateTab(b.id)
    await store.getState().runFilterQuery(b.id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 5 })
    expect(store.getState().queriesByTab[a.id].rows).toEqual([[`q-${a.fileId}`]])
    expect(store.getState().queriesByTab[b.id].rows).toEqual([[`q-${b.fileId}`]])
    await store.getState().flushSave()
    const serialized = JSON.stringify(vi.mocked(desktop.saveSession).mock.calls.at(-1)![0])
    for (const forbidden of ['queryId', 'rows', 'returnedRows', 'elapsedMs', 'loadingBatch', 'generation']) expect(serialized).not.toContain(forbidden)
  })
})
