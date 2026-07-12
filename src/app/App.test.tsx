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
  expect(screen.getByText('File opened')).toBeInTheDocument()
  expect(screen.queryByText('Schema')).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: /sql/i })).not.toBeInTheDocument()
  expect(screen.queryByText('Data')).not.toBeInTheDocument()
  view.unmount()
  await waitFor(() => expect(unlisten).toHaveBeenCalled())
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
