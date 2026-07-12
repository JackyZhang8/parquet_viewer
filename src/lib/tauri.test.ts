import { beforeEach, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn() }))

import { desktopApi } from './tauri'

const tab = () => ({
  id: 'tab-1', fileId: 'file-1', path: '/a.parquet', sqlDraft: '', filters: [], sorts: [],
  viewState: { scrollTop: 0, scrollLeft: 2, sidebarWidth: 240, editorHeight: 180 },
})

beforeEach(() => invoke.mockReset())

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
