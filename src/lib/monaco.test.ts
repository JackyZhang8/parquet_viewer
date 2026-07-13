import { expect, it, vi } from 'vitest'

const { config, worker } = vi.hoisted(() => ({ config: vi.fn(), worker: vi.fn(function LocalWorker() {}) }))
vi.mock('@monaco-editor/react', () => ({ loader: { config } }))
vi.mock('monaco-editor/esm/vs/editor/editor.api', () => ({ editor: { marker: true } }))
vi.mock('monaco-editor/esm/vs/basic-languages/sql/sql.contribution', () => ({}))
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: worker }))

it('configures the React loader and worker from local Monaco modules', async () => {
  const module = await import('./monaco')
  expect(config).toHaveBeenCalledWith({ monaco: module.monaco })
  expect(globalThis.MonacoEnvironment?.getWorker?.('', 'sql')).toBeInstanceOf(worker)
})
