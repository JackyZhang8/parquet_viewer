import { beforeEach, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
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

beforeEach(() => invoke.mockReset())

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
  const batch = { queryId: 'query-1', rows: [['9007199254740993']], done: true, returnedRows: '1', elapsedMs: '7' }
  invoke.mockResolvedValueOnce(started).mockResolvedValueOnce(batch).mockResolvedValueOnce(undefined)
  const request = { fileId: 'file-1', query: { selectedColumns: [], filters: [], sorts: [], previewLimit: 10000 }, batchSize: 500 }

  await expect(desktopApi.startFilterQuery(request)).resolves.toEqual(started)
  await expect(desktopApi.fetchQueryBatch('query-1')).resolves.toEqual(batch)
  await expect(desktopApi.cancelQuery('query-1')).resolves.toBeUndefined()
  expect(invoke.mock.calls).toEqual([
    ['start_filter_query', { request }],
    ['fetch_query_batch', { queryId: 'query-1' }],
    ['cancel_query', { queryId: 'query-1' }],
  ])
})

it.each([
  ['started extra key', { queryId: 'q', columns: [], hidden: true }, 'start'],
  ['started empty query id', { queryId: '', columns: [] }, 'start'],
  ['started malformed column', { queryId: 'q', columns: [{ name: '', logicalType: 'INT64', nullable: false }] }, 'start'],
  ['batch extra key', { queryId: 'q', rows: [], done: true, returnedRows: '0', elapsedMs: '0', hidden: true }, 'batch'],
  ['batch unsafe number', { queryId: 'q', rows: [[9007199254740992]], done: true, returnedRows: '1', elapsedMs: '0' }, 'batch'],
  ['batch malformed counter', { queryId: 'q', rows: [], done: true, returnedRows: '01', elapsedMs: '0' }, 'batch'],
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
