import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { DesktopApi, OpenFileOutcome } from '../lib/tauri'
import { createWorkspaceStore } from '../stores/workspace'
import { App } from './App'

vi.mock('../lib/monaco', () => ({}))

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const api = (): DesktopApi => ({
  openFiles: vi.fn(async (paths: string[]) => paths.map((path) => ({ ok: true as const, metadata: { fileId: path, path, name: path.split('/').pop()!, sizeBytes: '1', rowCount: '1', rowGroupCount: 1, columns: [] } }))),
  closeFile: vi.fn(async () => undefined),
  reloadFile: vi.fn(async (fileId: string) => ({ fileId, path: `/${fileId}.parquet`, name: `${fileId}.parquet`, sizeBytes: '1', rowCount: '1', rowGroupCount: 1, columns: [] })),
  isFileChanged: vi.fn(async () => false),
  startFilterQuery: vi.fn(async () => ({ queryId: 'q', columns: [] })),
  startQuery: vi.fn(async () => ({ queryId: 'sql-q', columns: [] })),
  fetchQueryBatch: vi.fn(async () => ({ queryId: 'q', rows: [], done: true, truncated: false, returnedRows: '0', elapsedMs: '0' })),
  cancelQuery: vi.fn(async () => undefined),
  cancelFileQueries: vi.fn(async () => undefined),
  inspectExport: vi.fn(async () => ({ estimatedRows: '1', requiresConfirmation: false })),
  startExport: vi.fn(async () => ({ exportId: 'export-1' })),
  cancelExport: vi.fn(async () => undefined),
  onExportProgress: vi.fn(async () => () => undefined),
  pickCsvDestination: vi.fn(async () => null),
  confirmLargeExport: vi.fn(async () => true),
  confirmExportOverwrite: vi.fn(async () => false),
  confirmCloseTabs: vi.fn(async () => true),
  loadSettings: vi.fn(async () => ({ language: 'en' as const, theme: 'system' as const, batchSize: 500, previewLimit: 10000, memoryLimitMb: 512, tempDirectory: null, tempDiskWarningMb: 1024, concurrency: 2, restoreTabs: true })),
  saveSettings: vi.fn(async (settings) => settings),
  pickDirectory: vi.fn(async () => null),
  loadSession: vi.fn(async () => ({ snapshot: { version: 1, tabs: [], activeTabId: null }, unavailableTabIds: [], warning: null })),
  saveSession: vi.fn(async () => undefined),
  pickParquetFiles: vi.fn(async () => null),
  onFileDrop: vi.fn(async () => () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
})

it('hydrates, subscribes/unsubscribes drops, and switches from empty intake to workspace', async () => {
  const desktop = api()
  let drop: ((paths: string[]) => void) | undefined
  const unlisten = vi.fn()
  vi.mocked(desktop.onFileDrop).mockImplementation(async (callback) => { drop = callback; return unlisten })
  const store = createWorkspaceStore(desktop)
  const view = render(<App api={desktop} store={store} />)
  expect((await screen.findAllByRole('button', { name: /open parquet files/i }))[0]).toBeInTheDocument()
  expect(desktop.loadSession).toHaveBeenCalledTimes(1)
  drop?.(['/drop.parquet'])
  await waitFor(() => expect(screen.getByRole('tab', { name: /drop.parquet/i })).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: 'Filters & SQL' })).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: /sql/i })).not.toBeInTheDocument()
  await waitFor(() => expect(desktop.startFilterQuery).toHaveBeenCalledTimes(1))
  expect(desktop.fetchQueryBatch).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('grid')).toBeInTheDocument()
  view.unmount()
  await waitFor(() => expect(unlisten).toHaveBeenCalled())
})

it('does not restore saved tabs when the restore setting is disabled', async () => {
  const desktop = api()
  vi.mocked(desktop.loadSettings).mockResolvedValue({ language: 'en', theme: 'system', batchSize: 500, previewLimit: 10000, memoryLimitMb: 512,
    tempDirectory: null, tempDiskWarningMb: 1024, concurrency: 2, restoreTabs: false })
  render(<App api={desktop} />)
  expect((await screen.findAllByRole('button', { name: /open parquet files/i }))[0]).toBeInTheDocument()
  expect(desktop.loadSession).not.toHaveBeenCalled()
})

it('automatically previews rows when a Parquet file opens', async () => {
  const desktop = api()
  vi.mocked(desktop.openFiles).mockResolvedValue([{
    ok: true,
    metadata: {
      fileId: 'a', path: '/a.parquet', name: 'a.parquet', sizeBytes: '1', rowCount: '1', rowGroupCount: 1,
      columns: [{ name: 'id', logicalType: 'INT64', nullable: false }],
    },
  }])
  vi.mocked(desktop.startFilterQuery).mockResolvedValue({
    queryId: 'preview-a', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }],
  })
  vi.mocked(desktop.fetchQueryBatch).mockResolvedValue({
    queryId: 'preview-a', rows: [[1]], done: true, truncated: false, returnedRows: '1', elapsedMs: '1',
  })
  const store = createWorkspaceStore(desktop)
  await store.getState().openPaths(['/a.parquet'])

  render(<App api={desktop} store={store} />)

  expect(await screen.findByRole('gridcell', { name: 'id, row 1: 1' })).toBeInTheDocument()
  expect(desktop.startFilterQuery).toHaveBeenCalledWith({
    fileId: 'a', query: { selectedColumns: [], filters: [], sorts: [], previewLimit: 10_000 }, batchSize: 500,
  })
})

it('shows an opening progress bar for at least a short minimum after a file opens', async () => {
  const desktop = api()
  const opening = deferred<OpenFileOutcome[]>()
  vi.mocked(desktop.pickParquetFiles).mockResolvedValue(['/slow.parquet'])
  vi.mocked(desktop.openFiles).mockImplementation(() => opening.promise)
  const store = createWorkspaceStore(desktop)
  render(<App api={desktop} store={store} />)

  await waitFor(() => expect(desktop.loadSession).toHaveBeenCalled())
  fireEvent.click(screen.getAllByRole('button', { name: 'Open Parquet files' })[0])
  expect(await screen.findByRole('progressbar', { name: 'Opening files' })).toBeInTheDocument()

  opening.resolve([{ ok: true, metadata: {
    fileId: 'slow', path: '/slow.parquet', name: 'slow.parquet', sizeBytes: '1', rowCount: '1', rowGroupCount: 1, columns: [],
  } }])
  await screen.findByRole('tab', { name: 'slow.parquet' })
  expect(screen.getByRole('progressbar', { name: 'Opening files' })).toBeInTheDocument()
  await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'Opening files' })).not.toBeInTheDocument(), { timeout: 500 })
})

it('replays the displayed query when Refresh is selected from the data context menu', async () => {
  const desktop = api()
  vi.mocked(desktop.openFiles).mockResolvedValue([{ ok: true, metadata: {
    fileId: 'refresh', path: '/refresh.parquet', name: 'refresh.parquet', sizeBytes: '1', rowCount: '1', rowGroupCount: 1,
    columns: [{ name: 'id', logicalType: 'INT64', nullable: false }],
  } }])
  vi.mocked(desktop.startFilterQuery).mockResolvedValue({ queryId: 'refresh-query', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })
  vi.mocked(desktop.fetchQueryBatch).mockResolvedValue({ queryId: 'refresh-query', rows: [[1]], done: true, truncated: false, returnedRows: '1', elapsedMs: '1' })
  const store = createWorkspaceStore(desktop)
  await store.getState().openPaths(['/refresh.parquet'])

  render(<App api={desktop} store={store} />)

  const cell = await screen.findByRole('gridcell', { name: 'id, row 1: 1' })
  fireEvent.contextMenu(cell, { clientX: 120, clientY: 80 })
  await userEvent.click(screen.getByRole('menuitem', { name: 'Refresh' }))

  expect(screen.getByRole('progressbar', { name: 'Refreshing data' })).toBeInTheDocument()

  await waitFor(() => expect(desktop.startFilterQuery).toHaveBeenCalledTimes(2))
  expect(desktop.startFilterQuery).toHaveBeenLastCalledWith({
    fileId: 'refresh', query: { selectedColumns: [], filters: [], sorts: [], previewLimit: 10_000 }, batchSize: 500,
  })
})

it('prompts to reload an externally modified file and replays its query', async () => {
  const interval = vi.spyOn(window, 'setInterval')
  let checkForExternalChanges: (() => void) | undefined
  interval.mockImplementation((callback, delay) => {
    if (delay === 2_000) checkForExternalChanges = callback as () => void
    return 1 as unknown as ReturnType<typeof window.setInterval>
  })
  try {
    const desktop = api()
    vi.mocked(desktop.openFiles).mockResolvedValue([{ ok: true, metadata: {
      fileId: 'changed', path: '/changed.parquet', name: 'changed.parquet', sizeBytes: '1', rowCount: '1', rowGroupCount: 1,
      columns: [{ name: 'id', logicalType: 'INT64', nullable: false }],
    } }])
    vi.mocked(desktop.reloadFile).mockResolvedValue({
      fileId: 'changed', path: '/changed.parquet', name: 'changed.parquet', sizeBytes: '2', rowCount: '2', rowGroupCount: 1,
      columns: [{ name: 'id', logicalType: 'INT64', nullable: false }],
    })
    vi.mocked(desktop.isFileChanged).mockResolvedValue(true)
    const store = createWorkspaceStore(desktop)
    await store.getState().openPaths(['/changed.parquet'])
    const tab = store.getState().tabs[0]
    await store.getState().runFilterQuery(tab.id, { selectedColumns: [], filters: [], sorts: [], previewLimit: 10_000 })
    render(<App api={desktop} store={store} />)

    expect(checkForExternalChanges).toBeDefined()
    act(() => { checkForExternalChanges?.() })
    await waitFor(() => expect(desktop.isFileChanged).toHaveBeenCalledWith('changed'))
    expect(await screen.findByRole('dialog', { name: 'File changed externally' })).toHaveTextContent('modified outside Parquet Viewer')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload file' })) })

    expect(desktop.reloadFile).toHaveBeenCalledWith('changed')
    expect(desktop.startFilterQuery).toHaveBeenCalledTimes(2)
  } finally { interval.mockRestore() }
})

it('opens exactly one on-demand query panel from the title bar', async () => {
  const desktop = api()
  vi.mocked(desktop.openFiles).mockResolvedValue([{ ok: true, metadata: {
    fileId: 'query', path: '/query.parquet', name: 'query.parquet', sizeBytes: '1', rowCount: '1', rowGroupCount: 1,
    columns: [{ name: 'id', logicalType: 'INT64', nullable: false }],
  } }])
  const store = createWorkspaceStore(desktop)
  await store.getState().openPaths(['/query.parquet'])

  render(<App api={desktop} store={store} />)

  await screen.findByRole('grid')
  const filter = screen.getByRole('button', { name: 'Filter' })
  const sql = screen.getByRole('button', { name: 'SQL' })
  expect(filter).toHaveAttribute('aria-expanded', 'false')
  expect(sql).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('region', { name: 'Filter query' })).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'SQL editor' })).not.toBeInTheDocument()

  await userEvent.click(filter)
  expect(filter).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('region', { name: 'Filter query' })).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'SQL editor' })).not.toBeInTheDocument()

  fireEvent.click(sql)
  expect(filter).toHaveAttribute('aria-expanded', 'false')
  expect(sql).toHaveAttribute('aria-expanded', 'true')
  expect(screen.queryByRole('region', { name: 'Filter query' })).not.toBeInTheDocument()
  expect(screen.getByRole('progressbar', { name: 'Loading SQL editor' })).toBeInTheDocument()
  expect(await screen.findByRole('button', { name: 'Run SQL' })).toBeInTheDocument()
})

it('puts Open Parquet files first among title-bar actions', () => {
  const desktop = api()
  const view = render(<App api={desktop} />)

  const actions = view.container.querySelector<HTMLElement>('.titlebar-actions')!
  const firstAction = actions.firstElementChild

  expect(firstAction).toHaveClass('open-button')
  expect(firstAction).toHaveTextContent('Open Parquet files')
})

it('uses the embedded JetBrains Mono typography for the application shell', () => {
  const view = render(<App api={api()} />)

  expect(view.container.querySelector('.app-shell')).toHaveClass('jetbrains-mono')
})

it('wraps each expanded query tool in a styled panel container', async () => {
  const desktop = api()
  vi.mocked(desktop.openFiles).mockResolvedValue([{ ok: true, metadata: {
    fileId: 'query-style', path: '/query-style.parquet', name: 'query-style.parquet', sizeBytes: '1',
    rowCount: '1', rowGroupCount: 1, columns: [{ name: 'id', logicalType: 'INT64', nullable: false }],
  } }])
  const store = createWorkspaceStore(desktop)
  await store.getState().openPaths(['/query-style.parquet'])
  const view = render(<App api={desktop} store={store} />)

  await screen.findByRole('grid')
  await userEvent.click(screen.getByRole('button', { name: 'Filter' }))
  expect(view.container.querySelector('.query-panel.query-panel-filter')).toContainElement(
    screen.getByRole('region', { name: 'Filter query' }),
  )
  await userEvent.click(screen.getByRole('button', { name: 'SQL' }))
  expect(view.container.querySelector('.query-panel.query-panel-sql')).toContainElement(
    await screen.findByRole('button', { name: 'Run SQL' }),
  )
})

it('applies filters and keeps their compact controls above the result grid', async () => {
  const desktop = api()
  vi.mocked(desktop.openFiles).mockResolvedValue([{ ok: true, metadata: {
    fileId: 'filter', path: '/filter.parquet', name: 'filter.parquet', sizeBytes: '1', rowCount: '1', rowGroupCount: 1,
    columns: [{ name: 'id', logicalType: 'INT64', nullable: false }],
  } }])
  const store = createWorkspaceStore(desktop)
  await store.getState().openPaths(['/filter.parquet'])
  const view = render(<App api={desktop} store={store} />)

  await screen.findByRole('grid')
  await userEvent.click(screen.getByRole('button', { name: 'Filter' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Filter value' }), '42')
  await userEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  await userEvent.click(screen.getByRole('button', { name: 'Run filters' }))
  await waitFor(() => expect(desktop.startFilterQuery).toHaveBeenLastCalledWith({
    fileId: 'filter', batchSize: 500,
    query: { selectedColumns: [], filters: [{ column: 'id', operator: 'eq', value: { type: 'integer', value: '42' } }], sorts: [], previewLimit: 10_000 },
  }))

  await userEvent.click(screen.getByRole('button', { name: 'Filter' }))
  const summary = await screen.findByRole('region', { name: 'Active filters' })
  expect(summary).toHaveClass('filter-summary')
  expect(summary).toHaveTextContent('id equals 42')
  const result = view.container.querySelector('.result-pane')!
  expect(summary.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: 'Remove id condition' }))
  await waitFor(() => expect(desktop.startFilterQuery).toHaveBeenLastCalledWith({
    fileId: 'filter', batchSize: 500,
    query: { selectedColumns: [], filters: [], sorts: [], previewLimit: 10_000 },
  }))
})

it('shows compact file statistics without duplicate column controls', async () => {
  const desktop = api()
  vi.mocked(desktop.openFiles).mockResolvedValue([{
    ok: true,
    metadata: {
      fileId: 'stats', path: '/stats.parquet', name: 'stats.parquet', sizeBytes: '2048', rowCount: '2', rowGroupCount: 1,
      columns: [
        { name: 'id', logicalType: 'INT64', nullable: false },
        { name: 'name', logicalType: 'VARCHAR', nullable: true },
      ],
    },
  }])
  vi.mocked(desktop.startFilterQuery).mockResolvedValue({
    queryId: 'stats-preview', columns: [
      { name: 'id', logicalType: 'INT64', nullable: false },
      { name: 'name', logicalType: 'VARCHAR', nullable: true },
    ],
  })
  vi.mocked(desktop.fetchQueryBatch).mockResolvedValue({
    queryId: 'stats-preview', rows: [[1, 'one'], [2, 'two']], done: true, truncated: false, returnedRows: '2', elapsedMs: '1',
  })
  const store = createWorkspaceStore(desktop)
  await store.getState().openPaths(['/stats.parquet'])

  const view = render(<App api={desktop} store={store} />)

  await screen.findByRole('gridcell', { name: 'name, row 1: one' })
  const toggle = screen.getByRole('button', { name: 'Statistics' })
  const titlebar = view.container.querySelector<HTMLElement>('.titlebar')!
  expect(within(titlebar).getByRole('button', { name: 'Statistics' })).toBeInTheDocument()
  expect(view.container.querySelector('.workspace-main .statistics-toggle')).toBeNull()
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(toggle)
  const drawer = screen.getByRole('complementary', { name: 'File statistics' })
  expect(drawer).toHaveTextContent(/rows.*2.*columns.*2/i)
  expect(within(drawer).queryByRole('checkbox')).not.toBeInTheDocument()
})

it('uses Chinese labels when the saved language is Chinese', async () => {
  const desktop = api()
  vi.mocked(desktop.loadSettings).mockResolvedValue({ language: 'zh', theme: 'system', batchSize: 500, previewLimit: 10000,
    memoryLimitMb: 512, tempDirectory: null, tempDiskWarningMb: 1024, concurrency: 2, restoreTabs: true })
  const store = createWorkspaceStore(desktop)
  await store.getState().openPaths(['/chinese.parquet'])

  render(<App api={desktop} store={store} />)

  expect(await screen.findByRole('button', { name: '设置' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '统计' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '打开 Parquet 文件' })).toBeInTheDocument()
  expect(document.documentElement.lang).toBe('zh-CN')
})

it('applies settings immediately while the dialog remains open', async () => {
  const desktop = api()
  const user = userEvent.setup()
  render(<App api={desktop} />)

  await user.click(await screen.findByRole('button', { name: 'Settings' }))
  await user.selectOptions(screen.getByLabelText('Theme'), 'dark')

  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(desktop.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }))
  expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
})

it('uses an app-styled confirmation dialog before closing a tab', async () => {
  const desktop = api()
  const store = createWorkspaceStore(desktop)
  await store.getState().openPaths(['/a.parquet'])
  render(<App api={desktop} store={store} />)

  await userEvent.click(await screen.findByRole('button', { name: 'Close a.parquet' }))

  const dialog = screen.getByRole('dialog', { name: 'Close files' })
  expect(dialog).toHaveClass('close-tabs-dialog')
  expect(dialog).toHaveTextContent('Close 1 open file?')
  expect(dialog).not.toHaveTextContent('Unsaved workspace state')
  expect(desktop.confirmCloseTabs).not.toHaveBeenCalled()
  await userEvent.click(within(dialog).getByText('Cancel', { selector: 'button' }))
  expect(screen.getByRole('tab', { name: 'a.parquet' })).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Close a.parquet' }))
  await userEvent.click(within(screen.getByRole('dialog', { name: 'Close files' })).getByRole('button', { name: 'Close file' }))
  await waitFor(() => expect(screen.queryByRole('tab', { name: 'a.parquet' })).not.toBeInTheDocument())
})

it('opens the About dialog', async () => {
  const desktop = api()
  render(<App api={desktop} />)

  await userEvent.click(await screen.findByRole('button', { name: 'About' }))

  expect(screen.getByRole('dialog', { name: 'About Parquet Viewer' })).toHaveTextContent('A fast, local desktop viewer for Parquet files.')
})

it('uses saved batch and preview defaults for the automatic preview', async () => {
  const desktop = api()
  vi.mocked(desktop.loadSettings).mockResolvedValue({ language: 'en', theme: 'system', batchSize: 750, previewLimit: 25000, memoryLimitMb: 512,
    tempDirectory: null, tempDiskWarningMb: 1024, concurrency: 2, restoreTabs: true })
  const store = createWorkspaceStore(desktop)
  await store.getState().openPaths(['/settings.parquet'])
  render(<App api={desktop} store={store} />)
  await waitFor(() => expect(desktop.startFilterQuery).toHaveBeenCalledWith({
    fileId: '/settings.parquet', query: { selectedColumns: [], filters: [], sorts: [], previewLimit: 25000 }, batchSize: 750,
  }))
})

it('previews restored tabs as each tab becomes active', async () => {
  const desktop = api()
  vi.mocked(desktop.loadSession).mockResolvedValue({snapshot:{version:1,activeTabId:'a',tabs:[
    {id:'a',fileId:'a',path:'/a.parquet',sqlDraft:'',filters:[],sorts:[],viewState:{scrollTop:0,scrollLeft:0,sidebarWidth:260,editorHeight:180}},
    {id:'b',fileId:'b',path:'/b.parquet',sqlDraft:'',filters:[],sorts:[],viewState:{scrollTop:0,scrollLeft:0,sidebarWidth:260,editorHeight:180}},
  ]},unavailableTabIds:[],warning:null})
  vi.mocked(desktop.openFiles).mockImplementation(async (paths) => paths.map((path)=>({ok:true as const,metadata:{fileId:path.slice(1,2),path,name:path.slice(1),sizeBytes:'1',rowCount:'1',rowGroupCount:1,columns:[{name:'id',logicalType:'INT64',nullable:false}]}})))
  vi.mocked(desktop.startFilterQuery).mockImplementation(async ({ fileId }) => ({ queryId: `q-${fileId}`, columns: [{name:'id',logicalType:'INT64',nullable:false}] }))
  vi.mocked(desktop.fetchQueryBatch).mockImplementation(async (queryId) => ({ queryId, rows: [[queryId]], done: true, truncated: false, returnedRows: '1', elapsedMs: '2' }))
  render(<App api={desktop} />)
  expect(await screen.findByRole('gridcell', { name: /q-a/i })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('tab',{name:/b.parquet/i}))
  expect(await screen.findByRole('gridcell', { name: /q-b/i })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('tab',{name:/a.parquet/i}))
  expect(screen.getByRole('gridcell', { name: /q-a/i })).toBeInTheDocument()
  expect(desktop.startQuery).not.toHaveBeenCalled()
})

it('exports the automatic preview, confirms overwrite, and renders terminal export progress', async () => {
  const desktop = api()
  let exportEvent: ((progress: import('../domain/types').ExportProgress) => void) | undefined
  vi.mocked(desktop.onExportProgress).mockImplementation(async (callback) => { exportEvent = callback; return () => undefined })
  vi.mocked(desktop.pickCsvDestination).mockResolvedValue('/tmp/a.csv')
  vi.mocked(desktop.confirmExportOverwrite).mockResolvedValue(true)
  vi.mocked(desktop.startExport)
    .mockRejectedValueOnce({ code: 'ALREADY_EXISTS', message: 'Export destination already exists', detail: null })
    .mockResolvedValueOnce({ exportId: 'export-1' })
  vi.mocked(desktop.loadSession).mockResolvedValue({ snapshot: { version: 1, activeTabId: 'a', tabs: [
    { id: 'a', fileId: 'a', path: '/a.parquet', sqlDraft: 'SELECT id FROM data', filters: [], sorts: [], viewState: { scrollTop: 0, scrollLeft: 0, sidebarWidth: 260, editorHeight: 180 } },
  ] }, unavailableTabIds: [], warning: null })
  vi.mocked(desktop.openFiles).mockResolvedValue([{ ok: true, metadata: { fileId: 'a', path: '/a.parquet', name: 'a.parquet', sizeBytes: '1', rowCount: '1', rowGroupCount: 1, columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] } }])
  vi.mocked(desktop.startFilterQuery).mockResolvedValue({ queryId: 'filter-a', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })
  vi.mocked(desktop.fetchQueryBatch).mockImplementation(async (queryId) => ({ queryId, rows: [[1]], done: true, truncated: false, returnedRows: '1', elapsedMs: '2' }))

  render(<App api={desktop} />)
  await screen.findByRole('gridcell', { name: /1/ })
  await userEvent.click(screen.getByRole('button', { name: /export csv/i }))

  await waitFor(() => expect(desktop.startExport).toHaveBeenCalledTimes(2))
  expect(desktop.startExport).toHaveBeenLastCalledWith({
    fileId: 'a', destination: '/tmp/a.csv', overwrite: true,
    source: { kind: 'filter', query: { selectedColumns: [], filters: [], sorts: [], previewLimit: 10000 } },
  })
  act(() => exportEvent?.({ exportId: 'export-1', status: 'completed', rowsWritten: '12000', error: null }))
  expect(await screen.findByRole('status', { name: /export status/i })).toHaveTextContent(/12,000 rows exported/i)
})

it('keeps terminal export progress emitted before startExport resolves', async () => {
  const desktop = api()
  let exportEvent: ((progress: import('../domain/types').ExportProgress) => void) | undefined
  vi.mocked(desktop.onExportProgress).mockImplementation(async (callback) => { exportEvent = callback; return () => undefined })
  vi.mocked(desktop.pickCsvDestination).mockResolvedValue('/tmp/early.csv')
  vi.mocked(desktop.startExport).mockImplementation(async () => {
    act(() => exportEvent?.({ exportId: 'export-early', status: 'completed', rowsWritten: '1', error: null }))
    return { exportId: 'export-early' }
  })
  vi.mocked(desktop.loadSession).mockResolvedValue({ snapshot: { version: 1, activeTabId: 'a', tabs: [
    { id: 'a', fileId: 'a', path: '/a.parquet', sqlDraft: 'SELECT id FROM data', filters: [], sorts: [], viewState: { scrollTop: 0, scrollLeft: 0, sidebarWidth: 260, editorHeight: 180 } },
  ] }, unavailableTabIds: [], warning: null })
  vi.mocked(desktop.openFiles).mockResolvedValue([{ ok: true, metadata: { fileId: 'a', path: '/a.parquet', name: 'a.parquet', sizeBytes: '1', rowCount: '1', rowGroupCount: 1, columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] } }])
  vi.mocked(desktop.startFilterQuery).mockResolvedValue({ queryId: 'filter-a', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })
  vi.mocked(desktop.fetchQueryBatch).mockImplementation(async (queryId) => ({ queryId, rows: [[1]], done: true, truncated: false, returnedRows: '1', elapsedMs: '2' }))

  render(<App api={desktop} />)
  await screen.findByRole('gridcell', { name: /1/ })
  await userEvent.click(screen.getByRole('button', { name: /export csv/i }))

  expect(await screen.findByRole('status', { name: /export status/i })).toHaveTextContent(/1 rows exported/i)
})

it('requires confirmation before starting a large CSV export', async () => {
  const desktop = api()
  const inspectExport = vi.fn(async () => ({ estimatedRows: '100000', requiresConfirmation: true }))
  const confirmLargeExport = vi.fn(async () => false)
  vi.mocked(desktop.inspectExport).mockImplementation(inspectExport)
  vi.mocked(desktop.confirmLargeExport).mockImplementation(confirmLargeExport)
  vi.mocked(desktop.pickCsvDestination).mockResolvedValue('/tmp/large.csv')
  vi.mocked(desktop.loadSession).mockResolvedValue({ snapshot: { version: 1, activeTabId: 'a', tabs: [
    { id: 'a', fileId: 'a', path: '/a.parquet', sqlDraft: 'SELECT id FROM data', filters: [], sorts: [], viewState: { scrollTop: 0, scrollLeft: 0, sidebarWidth: 260, editorHeight: 180 } },
  ] }, unavailableTabIds: [], warning: null })
  vi.mocked(desktop.openFiles).mockResolvedValue([{ ok: true, metadata: { fileId: 'a', path: '/a.parquet', name: 'a.parquet', sizeBytes: '1', rowCount: '1', rowGroupCount: 1, columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] } }])
  vi.mocked(desktop.startFilterQuery).mockResolvedValue({ queryId: 'filter-a', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })
  vi.mocked(desktop.fetchQueryBatch).mockImplementation(async (queryId) => ({ queryId, rows: [[1]], done: true, truncated: false, returnedRows: '1', elapsedMs: '2' }))

  render(<App api={desktop} />)
  await screen.findByRole('gridcell', { name: /1/ })
  await userEvent.click(screen.getByRole('button', { name: /export csv/i }))

  expect(inspectExport).toHaveBeenCalledWith({ fileId: 'a', source: { kind: 'filter', query: { selectedColumns: [], filters: [], sorts: [], previewLimit: 10000 } } })
  expect(confirmLargeExport).toHaveBeenCalledWith('100000')
  expect(desktop.startExport).not.toHaveBeenCalled()
  expect(desktop.pickCsvDestination).not.toHaveBeenCalled()
})

it('opens picker files from the workspace toolbar', async () => {
  const desktop = api()
  vi.mocked(desktop.pickParquetFiles).mockResolvedValue(['/picked.parquet'])
  const store = createWorkspaceStore(desktop)
  render(<App api={desktop} store={store} />)
  await userEvent.click((await screen.findAllByRole('button', { name: /open parquet files/i }))[0])
  expect(await screen.findByRole('tab', { name: /picked.parquet/i })).toBeInTheDocument()
})

it('shows queued status while backend admission is pending', async () => {
  const desktop = api(); const starting = deferred<{ queryId: string; columns: [] }>()
  vi.mocked(desktop.startFilterQuery).mockImplementation(() => starting.promise)
  const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/queued.parquet'])
  render(<App api={desktop} store={store} />)
  await waitFor(() => expect(within(screen.getByRole('contentinfo', { name: 'Query status' })).getByRole('status')).toHaveTextContent('Queued'))
  expect(screen.getByRole('button', { name: /stop query/i })).toBeInTheDocument()
  starting.resolve({ queryId: 'q', columns: [] })
  await waitFor(() => expect(within(screen.getByRole('contentinfo', { name: 'Query status' })).getByRole('status')).toHaveTextContent('Done'))
})

it('survives StrictMode effect replay with one live drop listener and debounced saves', async () => {
  const desktop = api()
  let active = 0
  vi.mocked(desktop.onFileDrop).mockImplementation(async () => { active += 1; return () => { active -= 1 } })
  const view = render(<StrictMode><App api={desktop} /></StrictMode>)
  await waitFor(() => expect(active).toBe(1))
  // A drop after replay changes the internal store and must still schedule persistence.
  const callback = vi.mocked(desktop.onFileDrop).mock.calls.at(-1)![0]
  await act(async () => { callback(['/strict.parquet']) })
  await waitFor(() => expect(desktop.saveSession).toHaveBeenCalled(), { timeout: 1000 })
  const saves = vi.mocked(desktop.saveSession).mock.calls.length
  await act(async () => { callback(['/pending.parquet']) })
  view.unmount()
  expect(active).toBe(0)
  await new Promise((resolve) => setTimeout(resolve, 350))
  expect(desktop.saveSession).toHaveBeenCalledTimes(saves)
})

it('surfaces rejected drop registration and picker without unhandled promises', async () => {
  const desktop = api()
  vi.mocked(desktop.onFileDrop).mockRejectedValue(new Error('drop denied'))
  vi.mocked(desktop.pickParquetFiles).mockRejectedValue(new Error('picker denied'))
  const view = render(<App api={desktop} />)
  const local = within(view.container)
  expect(await local.findByRole('alert')).toHaveTextContent(/file drop/i)
  await userEvent.click(local.getAllByRole('button', { name: /open parquet files/i })[0])
  expect(await local.findByText(/file picker/i)).toBeInTheDocument()
})
