import { render, screen, waitFor } from '@testing-library/react'
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
  expect(screen.getByText('Data preview will appear here')).toBeInTheDocument()
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
