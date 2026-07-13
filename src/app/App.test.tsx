import { act, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { DesktopApi } from '../lib/tauri'
import { createWorkspaceStore } from '../stores/workspace'
import { App } from './App'

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')
  return { default: (props: Record<string, unknown>) => React.createElement('textarea', {
    'aria-label': (props.options as { ariaLabel: string }).ariaLabel,
    value: props.value as string,
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => (props.onChange as Function)(event.target.value),
  }) }
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const api = (): DesktopApi => ({
  openFiles: vi.fn(async (paths: string[]) => paths.map((path) => ({ ok: true as const, metadata: { fileId: path, path, name: path.split('/').pop()!, sizeBytes: '1', rowCount: '1', rowGroupCount: 1, columns: [] } }))),
  closeFile: vi.fn(async () => undefined),
  startFilterQuery: vi.fn(async () => ({ queryId: 'q', columns: [] })),
  startQuery: vi.fn(async () => ({ queryId: 'sql-q', columns: [] })),
  fetchQueryBatch: vi.fn(async () => ({ queryId: 'q', rows: [], done: true, truncated: false, returnedRows: '0', elapsedMs: '0' })),
  cancelQuery: vi.fn(async () => undefined),
  startExport: vi.fn(async () => ({ exportId: 'export-1' })),
  cancelExport: vi.fn(async () => undefined),
  onExportProgress: vi.fn(async () => () => undefined),
  pickCsvDestination: vi.fn(async () => null),
  confirmExportOverwrite: vi.fn(async () => false),
  loadSettings: vi.fn(async () => ({ theme: 'system' as const, batchSize: 500, previewLimit: 10000, memoryLimitMb: 512, tempDirectory: null, tempDiskWarningMb: 1024, concurrency: 2, restoreTabs: true })),
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
  expect(screen.getByText('Schema')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: /sql/i })).not.toBeInTheDocument()
  expect(screen.queryByText('Data')).not.toBeInTheDocument()
  expect(desktop.startFilterQuery).not.toHaveBeenCalled()
  expect(desktop.fetchQueryBatch).not.toHaveBeenCalled()
  view.unmount()
  await waitFor(() => expect(unlisten).toHaveBeenCalled())
})

it('does not restore saved tabs when the restore setting is disabled', async () => {
  const desktop = api()
  vi.mocked(desktop.loadSettings).mockResolvedValue({ theme: 'system', batchSize: 500, previewLimit: 10000, memoryLimitMb: 512,
    tempDirectory: null, tempDiskWarningMb: 1024, concurrency: 2, restoreTabs: false })
  render(<App api={desktop} />)
  expect((await screen.findAllByRole('button', { name: /open parquet files/i }))[0]).toBeInTheDocument()
  expect(desktop.loadSession).not.toHaveBeenCalled()
})

it('uses saved batch and preview defaults for new filter queries', async () => {
  const desktop = api()
  vi.mocked(desktop.loadSettings).mockResolvedValue({ theme: 'system', batchSize: 750, previewLimit: 25000, memoryLimitMb: 512,
    tempDirectory: null, tempDiskWarningMb: 1024, concurrency: 2, restoreTabs: true })
  const store = createWorkspaceStore(desktop)
  await store.getState().openPaths(['/settings.parquet'])
  render(<App api={desktop} store={store} />)
  await waitFor(() => expect(screen.getByLabelText('Preview rows')).toHaveValue(25000))
  await userEvent.click(screen.getByRole('button', { name: 'Run filters' }))
  expect(desktop.startFilterQuery).toHaveBeenCalledWith({
    fileId: '/settings.parquet', query: { selectedColumns: [], filters: [], sorts: [], previewLimit: 25000 }, batchSize: 750,
  })
})

it('runs filters into isolated per-tab result grids without introducing a SQL editor', async () => {
  const desktop = api()
  vi.mocked(desktop.loadSession).mockResolvedValue({snapshot:{version:1,activeTabId:'a',tabs:[
    {id:'a',fileId:'a',path:'/a.parquet',sqlDraft:'',filters:[],sorts:[],viewState:{scrollTop:0,scrollLeft:0,sidebarWidth:260,editorHeight:180}},
    {id:'b',fileId:'b',path:'/b.parquet',sqlDraft:'',filters:[],sorts:[],viewState:{scrollTop:0,scrollLeft:0,sidebarWidth:260,editorHeight:180}},
  ]},unavailableTabIds:[],warning:null})
  vi.mocked(desktop.openFiles).mockImplementation(async (paths) => paths.map((path)=>({ok:true as const,metadata:{fileId:path.slice(1,2),path,name:path.slice(1),sizeBytes:'1',rowCount:'1',rowGroupCount:1,columns:[{name:'id',logicalType:'INT64',nullable:false}]}})))
  vi.mocked(desktop.startFilterQuery).mockImplementation(async ({ fileId }) => ({ queryId: `q-${fileId}`, columns: [{name:'id',logicalType:'INT64',nullable:false}] }))
  vi.mocked(desktop.fetchQueryBatch).mockImplementation(async (queryId) => ({ queryId, rows: [[queryId]], done: true, truncated: false, returnedRows: '1', elapsedMs: '2' }))
  render(<App api={desktop} />)
  await userEvent.type(await screen.findByLabelText('Filter value'),'1')
  await userEvent.click(screen.getByRole('button',{name:'Add condition'}))
  expect(screen.getByText(/id equals/i)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Run filters' }))
  expect(await screen.findByRole('gridcell', { name: /q-a/i })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('tab',{name:/b.parquet/i}))
  expect(screen.queryByText(/id equals/i)).not.toBeInTheDocument()
  expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('tab',{name:/a.parquet/i}))
  expect(screen.getByText(/id equals/i)).toBeInTheDocument()
  expect(screen.getByRole('gridcell', { name: /q-a/i })).toBeInTheDocument()
  expect(screen.queryByRole('textbox',{name:/sql/i})).not.toBeInTheDocument()
})

it('toggles SQL per tab, restores drafts/heights, runs into the same isolated grid, and never runs on hydrate', async () => {
  const desktop = api()
  vi.mocked(desktop.loadSession).mockResolvedValue({snapshot:{version:1,activeTabId:'a',tabs:[
    {id:'a',fileId:'a',path:'/a.parquet',sqlDraft:'SELECT alpha FROM data',filters:[],sorts:[],viewState:{scrollTop:0,scrollLeft:0,sidebarWidth:260,editorHeight:210}},
    {id:'b',fileId:'b',path:'/b.parquet',sqlDraft:'SELECT beta FROM data',filters:[],sorts:[],viewState:{scrollTop:0,scrollLeft:0,sidebarWidth:260,editorHeight:260}},
  ]},unavailableTabIds:[],warning:null})
  vi.mocked(desktop.openFiles).mockImplementation(async (paths) => paths.map((path)=>({ok:true as const,metadata:{fileId:path.slice(1,2),path,name:path.slice(1),sizeBytes:'1',rowCount:'1',rowGroupCount:1,columns:[{name:path.includes('a.')?'alpha':'beta',logicalType:'VARCHAR',nullable:false}]}})))
  vi.mocked(desktop.startQuery).mockImplementation(async ({ fileId }) => ({ queryId: `sql-${fileId}`, columns: [{name:fileId === 'a' ? 'alpha' : 'beta',logicalType:'VARCHAR',nullable:false}] }))
  vi.mocked(desktop.fetchQueryBatch).mockImplementation(async (queryId) => ({ queryId, rows: [[queryId]], done: true, truncated: false, returnedRows: '1', elapsedMs: '2' }))
  render(<App api={desktop} />)
  await screen.findByRole('tab', { name: /a.parquet/i })
  expect(desktop.startQuery).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('tab', { name: 'SQL' }))
  expect(screen.getByRole('textbox', { name: 'SQL editor' })).toHaveValue('SELECT alpha FROM data')
  await userEvent.click(screen.getByRole('button', { name: 'Run SQL' }))
  expect(await screen.findByRole('gridcell', { name: /sql-a/ })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('tab', { name: /b.parquet/i }))
  expect(screen.getByRole('tab', { name: 'Filter' })).toHaveAttribute('aria-selected', 'true')
  await userEvent.click(screen.getByRole('tab', { name: 'SQL' }))
  expect(screen.getByRole('textbox', { name: 'SQL editor' })).toHaveValue('SELECT beta FROM data')
  expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('tab', { name: /a.parquet/i }))
  expect(screen.getByRole('textbox', { name: 'SQL editor' })).toHaveValue('SELECT alpha FROM data')
  expect(screen.getByRole('gridcell', { name: /sql-a/ })).toBeInTheDocument()
})

it('exports the submitted SQL, confirms overwrite, and renders terminal export progress', async () => {
  const desktop = api()
  let exportEvent: ((progress: import('../domain/types').ExportProgress) => void) | undefined
  vi.mocked(desktop.onExportProgress).mockImplementation(async (callback) => { exportEvent = callback; return () => undefined })
  vi.mocked(desktop.pickCsvDestination).mockResolvedValue('/tmp/a.csv')
  vi.mocked(desktop.confirmExportOverwrite).mockResolvedValue(true)
  vi.mocked(desktop.startExport)
    .mockRejectedValueOnce({ code: 'INVALID_ARGUMENT', message: 'Export destination already exists', detail: null })
    .mockResolvedValueOnce({ exportId: 'export-1' })
  vi.mocked(desktop.loadSession).mockResolvedValue({ snapshot: { version: 1, activeTabId: 'a', tabs: [
    { id: 'a', fileId: 'a', path: '/a.parquet', sqlDraft: 'SELECT id FROM data', filters: [], sorts: [], viewState: { scrollTop: 0, scrollLeft: 0, sidebarWidth: 260, editorHeight: 180 } },
  ] }, unavailableTabIds: [], warning: null })
  vi.mocked(desktop.openFiles).mockResolvedValue([{ ok: true, metadata: { fileId: 'a', path: '/a.parquet', name: 'a.parquet', sizeBytes: '1', rowCount: '1', rowGroupCount: 1, columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] } }])
  vi.mocked(desktop.startQuery).mockResolvedValue({ queryId: 'sql-a', columns: [{ name: 'id', logicalType: 'INT64', nullable: false }] })
  vi.mocked(desktop.fetchQueryBatch).mockResolvedValue({ queryId: 'sql-a', rows: [[1]], done: true, truncated: false, returnedRows: '1', elapsedMs: '2' })

  render(<App api={desktop} />)
  await userEvent.click(await screen.findByRole('tab', { name: 'SQL' }))
  await userEvent.click(screen.getByRole('button', { name: 'Run SQL' }))
  await screen.findByRole('gridcell', { name: /1/ })
  await userEvent.click(screen.getByRole('button', { name: /export csv/i }))

  await waitFor(() => expect(desktop.startExport).toHaveBeenCalledTimes(2))
  expect(desktop.startExport).toHaveBeenLastCalledWith({
    fileId: 'a', destination: '/tmp/a.csv', overwrite: true,
    source: { kind: 'sql', sql: 'SELECT id FROM data' },
  })
  act(() => exportEvent?.({ exportId: 'export-1', status: 'completed', rowsWritten: '12000', error: null }))
  expect(await screen.findByRole('status', { name: /export status/i })).toHaveTextContent(/12,000 rows exported/i)
})

it('provides roving keyboard query-mode tabs with associated tabpanels', async () => {
  const desktop = api(); const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/keys.parquet'])
  render(<App api={desktop} store={store} />)
  const filter = screen.getByRole('tab', { name: 'Filter' }); const sql = screen.getByRole('tab', { name: 'SQL' })
  expect(filter).toHaveAttribute('tabindex', '0'); expect(sql).toHaveAttribute('tabindex', '-1')
  expect(filter).toHaveAttribute('aria-controls', expect.stringContaining('filter-panel'))
  expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', filter.id)
  filter.focus(); await userEvent.keyboard('{ArrowRight}')
  expect(sql).toHaveFocus(); expect(sql).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', sql.id)
  await userEvent.keyboard('{Home}')
  expect(filter).toHaveFocus(); expect(filter).toHaveAttribute('aria-selected', 'true')
  await userEvent.keyboard('{End}')
  expect(sql).toHaveFocus()
})

it('does not attach a late SQL error marker/detail to a modified draft', async () => {
  const desktop = api(); const pending = deferred<never>()
  vi.mocked(desktop.startQuery).mockImplementation(() => pending.promise)
  const store = createWorkspaceStore(desktop); await store.getState().openPaths(['/revision.parquet']); const tab = store.getState().tabs[0]
  store.getState().setSqlDraft(tab.id, 'SELECT missing FROM data')
  render(<App api={desktop} store={store} />)
  await userEvent.click(screen.getByRole('tab', { name: 'SQL' }))
  await userEvent.click(screen.getByRole('button', { name: 'Run SQL' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'SQL editor' }), ' -- changed')
  pending.reject({ code: 'SQL_ERROR', message: 'The query failed', detail: 'Binder Error\nline 1 column 8' })
  expect(await screen.findByRole('alert')).toHaveTextContent('SQL_ERROR')
  expect(screen.queryByText('Error details')).not.toBeInTheDocument()
})

it('does not leak schema search or collapse state between tabs', async () => {
  const desktop = api()
  vi.mocked(desktop.loadSession).mockResolvedValue({snapshot:{version:1,activeTabId:'a',tabs:[
    {id:'a',fileId:'a',path:'/a.parquet',sqlDraft:'',filters:[],sorts:[],viewState:{scrollTop:0,scrollLeft:0,sidebarWidth:260,editorHeight:180}},
    {id:'b',fileId:'b',path:'/b.parquet',sqlDraft:'',filters:[],sorts:[],viewState:{scrollTop:0,scrollLeft:0,sidebarWidth:260,editorHeight:180}},
  ]},unavailableTabIds:[],warning:null})
  vi.mocked(desktop.openFiles).mockImplementation(async (paths) => paths.map((path)=>({ok:true as const,metadata:{fileId:path.slice(1,2),path,name:path.slice(1),sizeBytes:'1',rowCount:'1',rowGroupCount:1,columns:[{name:'alpha',logicalType:'INT64',nullable:false},{name:'beta',logicalType:'INT64',nullable:false}]}})))
  render(<App api={desktop} />)
  await userEvent.type(await screen.findByRole('searchbox',{name:/search fields/i}),'zzz')
  await userEvent.click(screen.getByRole('button',{name:/collapse schema/i}))
  await userEvent.click(screen.getByRole('tab',{name:/b.parquet/i}))
  expect(screen.getByRole('searchbox',{name:/search fields/i})).toHaveValue('')
  await userEvent.click(screen.getByRole('tab',{name:/a.parquet/i}))
  expect(screen.getByRole('searchbox',{name:/search fields/i})).toHaveValue('')
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
  await userEvent.click(screen.getByRole('button', { name: 'Run filters' }))
  expect(within(screen.getByRole('contentinfo', { name: 'Query status' })).getByRole('status')).toHaveTextContent('Queued')
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
