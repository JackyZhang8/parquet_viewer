import { beforeEach, expect, it, vi } from 'vitest'

const { invoke, listen, save, ask } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), save: vi.fn(), ask: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save, ask }))
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn() }))

import { desktopApi, normalizeOpenOutcomes } from './tauri'

const opened = () => ({
  fileId: 'file-1', path: '/a.parquet', name: 'a.parquet', sizeBytes: '18446744073709551615',
  rowCount: '0', rowGroupCount: 2,
  columns: [{ name: 'id', logicalType: 'INT64', nullable: false }],
})

const tab = () => ({
  id: 'tab-1', fileId: 'file-1', path: '/a.parquet', sqlDraft: '', filters: [], sorts: [],
  viewState: { scrollTop: 0, scrollLeft: 2, sidebarWidth: 240, editorHeight: 180 },
})

beforeEach(() => { invoke.mockReset(); listen.mockReset(); save.mockReset(); ask.mockReset() })

it('accepts exact tagged open outcomes', () => {
  const error = { code: 'INVALID_PARQUET', message: 'Bad footer', detail: null }
  expect(normalizeOpenOutcomes([{ Ok: opened() }, { Err: error }])).toEqual([
    { ok: true, metadata: opened() }, { ok: false, error },
  ])
})

it.each([
  ['invalid decimal', { Ok: { ...opened(), sizeBytes: '12.5' } }],
  ['negative decimal', { Ok: { ...opened(), rowCount: '-1' } }],
  ['leading zero', { Ok: { ...opened(), sizeBytes: '01' } }],
  ['u64 overflow', { Ok: { ...opened(), sizeBytes: '18446744073709551616' } }],
  ['NaN row groups', { Ok: { ...opened(), rowGroupCount: Number.NaN } }],
  ['fractional row groups', { Ok: { ...opened(), rowGroupCount: 1.5 } }],
  ['overflow row groups', { Ok: { ...opened(), rowGroupCount: 0x1_0000_0000 } }],
  ['extra metadata key', { Ok: { ...opened(), queryId: 'leak' } }],
  ['extra column key', { Ok: { ...opened(), columns: [{ ...opened().columns[0], secret: true }] } }],
  ['both result tags', { Ok: opened(), Err: { code: 'INVALID_PARQUET', message: 'Bad', detail: null } }],
  ['extra error key', { Err: { code: 'INVALID_PARQUET', message: 'Bad', detail: null, debug: '/secret' } }],
])('sanitizes malformed open outcome: %s', (_name, outcome) => {
  expect(normalizeOpenOutcomes([outcome])).toEqual([{
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred', detail: null },
  }])
})

it('invokes the filter query lifecycle with typed arguments', async () => {
  const started = { queryId: 'query-1', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] }
  const batch = { queryId: 'query-1', rows: [['9007199254740993']], done: true, truncated: false, returnedRows: '1', elapsedMs: '7' }
  invoke.mockResolvedValueOnce(started).mockResolvedValueOnce(batch).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
  const request = { fileId: 'file-1', query: { selectedColumns: [], filters: [], sorts: [], previewLimit: 10000 }, batchSize: 500 }

  await expect(desktopApi.startFilterQuery(request)).resolves.toEqual(started)
  await expect(desktopApi.fetchQueryBatch('query-1')).resolves.toEqual(batch)
  await expect(desktopApi.cancelQuery('query-1')).resolves.toBeUndefined()
  await expect(desktopApi.cancelFileQueries('file-1')).resolves.toBeUndefined()
  expect(invoke.mock.calls).toEqual([
    ['start_filter_query', { request }],
    ['fetch_query_batch', { queryId: 'query-1' }],
    ['cancel_query', { queryId: 'query-1' }],
    ['cancel_file_queries', { fileId: 'file-1' }],
  ])
})

it('invokes raw SQL with an exact QueryRequest and validates QueryStarted', async () => {
  const started = { queryId: 'sql-1', columns: [{ name: 'total', logicalType: 'HUGEINT', nullable: true }] }
  invoke.mockResolvedValue(started)
  const request = { fileId: 'file-1', sql: 'SELECT count(*) AS total FROM data', batchSize: 250, previewLimit: 9000 }

  await expect(desktopApi.startQuery(request)).resolves.toEqual(started)
  expect(invoke).toHaveBeenCalledWith('start_query', { request })

  invoke.mockResolvedValue({ ...started, debug: '/private/path' })
  await expect(desktopApi.startQuery(request)).rejects.toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred', detail: null })
})

it('checks an opened file for external changes and reloads its metadata', async () => {
  const reloaded = opened()
  invoke.mockResolvedValueOnce(true).mockResolvedValueOnce(reloaded)

  await expect(desktopApi.isFileChanged('file-1')).resolves.toBe(true)
  await expect(desktopApi.reloadFile('file-1')).resolves.toEqual(reloaded)
  expect(invoke.mock.calls).toEqual([
    ['check_file_changed', { fileId: 'file-1' }],
    ['reload_file', { fileId: 'file-1' }],
  ])
})

it('runs the export lifecycle, validates progress events, and uses native save confirmation', async () => {
  const started = { exportId: 'export-1' }
  const inspection = { estimatedRows: '100000', requiresConfirmation: true }
  invoke.mockResolvedValueOnce(inspection).mockResolvedValueOnce(started).mockResolvedValueOnce(undefined)
  save.mockResolvedValue('/tmp/result.csv')
  ask.mockResolvedValue(true)
  let eventHandler: ((event: { payload: unknown }) => void) | undefined
  const unlisten = vi.fn()
  listen.mockImplementation(async (_event: string, handler: (event: { payload: unknown }) => void) => { eventHandler = handler; return unlisten })
  const request = { fileId: 'file-1', destination: '/tmp/result.csv', overwrite: false, source: { kind: 'sql' as const, sql: 'SELECT * FROM data' } }

  await expect(desktopApi.inspectExport({ fileId: request.fileId, source: request.source })).resolves.toEqual(inspection)
  await expect(desktopApi.startExport(request)).resolves.toEqual(started)
  await expect(desktopApi.cancelExport('export-1')).resolves.toBeUndefined()
  await expect(desktopApi.pickCsvDestination('result.csv')).resolves.toBe('/tmp/result.csv')
  await expect(desktopApi.confirmLargeExport('100000')).resolves.toBe(true)
  await expect(desktopApi.confirmExportOverwrite('/tmp/result.csv')).resolves.toBe(true)
  const progress = vi.fn()
  await expect(desktopApi.onExportProgress(progress)).resolves.toBe(unlisten)
  eventHandler?.({ payload: { exportId: 'export-1', status: 'completed', rowsWritten: '12', error: null } })
  eventHandler?.({ payload: { exportId: 'export-1', status: 'completed', rowsWritten: 12, error: null } })

  expect(progress).toHaveBeenCalledOnce()
  expect(invoke.mock.calls).toEqual([
    ['inspect_export', { request: { fileId: 'file-1', source: { kind: 'sql', sql: 'SELECT * FROM data' } } }],
    ['start_export', { request }],
    ['cancel_export', { exportId: 'export-1' }],
  ])
})

it('confirms closing tabs with a localized native prompt', async () => {
  ask.mockResolvedValue(true)

  await expect(desktopApi.confirmCloseTabs(2, 'en')).resolves.toBe(true)
  expect(ask).toHaveBeenCalledWith(
    'Close 2 open files? Unsaved workspace state will be lost.',
    { title: 'Close files', kind: 'warning' },
  )
})

it('loads and saves exact settings and selects a native directory', async () => {
  const settings = { language: 'en' as const, theme: 'dark' as const, batchSize: 500, previewLimit: 10000, memoryLimitMb: 512,
    tempDirectory: null, tempDiskWarningMb: 1024, concurrency: 2, restoreTabs: true }
  invoke.mockResolvedValueOnce(settings).mockResolvedValueOnce(settings)
  const { open } = await import('@tauri-apps/plugin-dialog')
  vi.mocked(open).mockResolvedValue('/tmp/queries')

  await expect(desktopApi.loadSettings()).resolves.toEqual(settings)
  await expect(desktopApi.saveSettings(settings)).resolves.toEqual(settings)
  await expect(desktopApi.pickDirectory()).resolves.toBe('/tmp/queries')
  expect(invoke.mock.calls).toEqual([
    ['load_settings'],
    ['save_settings', { settings }],
  ])
})

it.each([
  ['started extra key', { queryId: 'q', columns: [], hidden: true }, 'start'],
  ['started empty query id', { queryId: '', columns: [] }, 'start'],
  ['started malformed column', { queryId: 'q', columns: [{ name: '', logicalType: 'INT64', nullable: false }] }, 'start'],
  ['batch extra key', { queryId: 'q', rows: [], done: true, truncated: false, returnedRows: '0', elapsedMs: '0', hidden: true }, 'batch'],
  ['batch unsafe number', { queryId: 'q', rows: [[9007199254740992]], done: true, truncated: false, returnedRows: '1', elapsedMs: '0' }, 'batch'],
  ['batch malformed counter', { queryId: 'q', rows: [], done: true, truncated: false, returnedRows: '01', elapsedMs: '0' }, 'batch'],
])('sanitizes malformed query payload: %s', async (_name, payload, command) => {
  invoke.mockResolvedValue(payload)
  const promise = command === 'start'
    ? desktopApi.startFilterQuery({ fileId: 'f', query: { selectedColumns: [], filters: [], sorts: [], previewLimit: 1 }, batchSize: 1 })
    : desktopApi.fetchQueryBatch('q')
  await expect(promise).rejects.toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred', detail: null })
})

it('accepts an exact restored session payload', async () => {
  const restored = { snapshot: { version: 1, tabs: [tab()], activeTabId: 'tab-1' }, unavailableTabIds: [], warning: null }
  invoke.mockResolvedValue(restored)
  await expect(desktopApi.loadSession()).resolves.toEqual(restored)
})

it.each([
  ['unknown snapshot field', { snapshot: { version: 1, tabs: [tab()], activeTabId: 'tab-1', queryId: 'leak' }, unavailableTabIds: [], warning: null }],
  ['unknown tab field', { snapshot: { version: 1, tabs: [{ ...tab(), metadata: {} }], activeTabId: 'tab-1' }, unavailableTabIds: [], warning: null }],
  ['invalid filter scalar', { snapshot: { version: 1, tabs: [{ ...tab(), filters: [{ column: 'x', operator: 'eq', value: { type: 'integer', value: '01' } }] }], activeTabId: 'tab-1' }, unavailableTabIds: [], warning: null }],
  ['invalid sort direction', { snapshot: { version: 1, tabs: [{ ...tab(), sorts: [{ column: 'x', direction: 'sideways' }] }], activeTabId: 'tab-1' }, unavailableTabIds: [], warning: null }],
  ['unsafe view integer', { snapshot: { version: 1, tabs: [{ ...tab(), viewState: { ...tab().viewState, scrollTop: -1 } }], activeTabId: 'tab-1' }, unavailableTabIds: [], warning: null }],
  ['unknown active tab', { snapshot: { version: 1, tabs: [tab()], activeTabId: 'missing' }, unavailableTabIds: [], warning: null }],
  ['unknown unavailable tab', { snapshot: { version: 1, tabs: [tab()], activeTabId: 'tab-1' }, unavailableTabIds: ['missing'], warning: null }],
])('rejects malformed restored sessions: %s', async (_name, restored) => {
  invoke.mockResolvedValue(restored)
  await expect(desktopApi.loadSession()).rejects.toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred', detail: null })
})

it.each([
  ['missing', [{ Ok: opened() }], ['/a', '/b']],
  ['extra', [{ Ok: opened() }, { Ok: { ...opened(), fileId: 'file-2', path: '/b', name: 'b' } }], ['/a']],
])('closes returned handles and rejects %s open outcome cardinality', async (_name, outcomes, paths) => {
  invoke.mockImplementation(async (command: string) => command === 'open_files' ? outcomes : undefined)
  await expect(desktopApi.openFiles(paths)).rejects.toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred', detail: null })
  expect(invoke.mock.calls.filter(([command]) => command === 'close_file').map(([, args]) => args)).toEqual(
    outcomes.map((outcome) => ({ fileId: outcome.Ok.fileId })),
  )
})
