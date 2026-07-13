import { act, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { DesktopApi } from '../lib/tauri'
import { createWorkspaceStore } from '../stores/workspace'
import { App } from './App'

const api = (): DesktopApi => ({
  openFiles: vi.fn(async (paths: string[]) => paths.map((path) => ({ ok: true as const, metadata: { fileId: path, path, name: path.split('/').pop()!, sizeBytes: '1', rowCount: '1', rowGroupCount: 1, columns: [] } }))),
  closeFile: vi.fn(async () => undefined),
  startFilterQuery: vi.fn(async () => ({ queryId: 'q', columns: [] })),
  fetchQueryBatch: vi.fn(async () => ({ queryId: 'q', rows: [], done: true, returnedRows: '0', elapsedMs: '0' })),
  cancelQuery: vi.fn(async () => undefined),
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

it('runs filters into isolated per-tab result grids without introducing a SQL editor', async () => {
  const desktop = api()
  vi.mocked(desktop.loadSession).mockResolvedValue({snapshot:{version:1,activeTabId:'a',tabs:[
    {id:'a',fileId:'a',path:'/a.parquet',sqlDraft:'',filters:[],sorts:[],viewState:{scrollTop:0,scrollLeft:0,sidebarWidth:260,editorHeight:180}},
    {id:'b',fileId:'b',path:'/b.parquet',sqlDraft:'',filters:[],sorts:[],viewState:{scrollTop:0,scrollLeft:0,sidebarWidth:260,editorHeight:180}},
  ]},unavailableTabIds:[],warning:null})
  vi.mocked(desktop.openFiles).mockImplementation(async (paths) => paths.map((path)=>({ok:true as const,metadata:{fileId:path.slice(1,2),path,name:path.slice(1),sizeBytes:'1',rowCount:'1',rowGroupCount:1,columns:[{name:'id',logicalType:'INT64',nullable:false}]}})))
  vi.mocked(desktop.startFilterQuery).mockImplementation(async ({ fileId }) => ({ queryId: `q-${fileId}`, columns: [{name:'id',logicalType:'INT64',nullable:false}] }))
  vi.mocked(desktop.fetchQueryBatch).mockImplementation(async (queryId) => ({ queryId, rows: [[queryId]], done: true, returnedRows: '1', elapsedMs: '2' }))
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
