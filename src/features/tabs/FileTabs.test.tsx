import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { WorkspaceTab } from '../../stores/workspace'
import { FileTabs } from './FileTabs'

const tab = (id: string, path: string): WorkspaceTab => ({
  id, fileId: id, path, status: 'ready', sqlDraft: '', filters: [], sorts: [],
  viewState: { scrollTop: 0, scrollLeft: 0, sidebarWidth: 240, editorHeight: 180 },
  metadata: { fileId: id, path, name: path.split('/').pop()!, sizeBytes: '2048', rowCount: '3', rowGroupCount: 1, columns: [] },
})

it('provides accessible activation, keyboard navigation, close, search, and context actions', async () => {
  const tabs = [tab('a', '/one/data.parquet'), tab('b', '/two/data.parquet'), tab('c', '/three/other.parquet')]
  const activate = vi.fn(), close = vi.fn(), closeOthers = vi.fn(), closeRight = vi.fn(), reveal = vi.fn()
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText')
  render(<FileTabs tabs={tabs} activeTabId="a" onActivate={activate} onClose={close} onCloseOthers={closeOthers} onCloseRight={closeRight} onReveal={reveal} />)

  expect(screen.getByRole('tablist')).toBeInTheDocument()
  const first = screen.getAllByRole('tab')[0]
  expect(first).toHaveAttribute('aria-selected', 'true')
  first.focus()
  await user.keyboard('{ArrowRight}')
  expect(activate).toHaveBeenCalledWith('b')
  expect(document.activeElement).toBe(screen.getAllByRole('tab')[1])
  await user.keyboard('{End}')
  expect(activate).toHaveBeenCalledWith('c')
  expect(document.activeElement).toBe(screen.getAllByRole('tab')[2])
  await user.keyboard('{Home}')
  expect(activate).toHaveBeenCalledWith('a')
  expect(document.activeElement).toBe(first)
  await user.keyboard('{Delete}')
  expect(close).toHaveBeenCalledWith('a')

  await user.click(screen.getByRole('button', { name: /opened files/i }))
  await user.type(screen.getByRole('searchbox'), 'other')
  await user.click(screen.getByRole('option', { name: /other.parquet/i }))
  expect(activate).toHaveBeenCalledWith('c')

  await user.pointer({ keys: '[MouseRight]', target: first })
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Close' }))
  await user.click(screen.getByRole('menuitem', { name: 'Copy path' }))
  expect(writeText).toHaveBeenCalledWith('/one/data.parquet')
  await user.pointer({ keys: '[MouseRight]', target: first })
  await user.click(screen.getByRole('menuitem', { name: 'Reveal in file manager' }))
  expect(reveal).toHaveBeenCalledWith('/one/data.parquet')
})

it('uses sibling tab and close controls and dismisses menus with Escape/outside click', async () => {
  const user = userEvent.setup()
  const view = render(<FileTabs tabs={[tab('a', '/a.parquet')]} activeTabId="a" onActivate={vi.fn()} onClose={vi.fn()} onCloseOthers={vi.fn()} onCloseRight={vi.fn()} onReveal={vi.fn()} />)
  const local = within(view.container)
  const semanticTab = local.getByRole('tab')
  expect(semanticTab.querySelector('button')).toBeNull()
  expect(local.getByRole('button', { name: /close a.parquet/i })).not.toBe(semanticTab)
  await user.pointer({ keys: '[MouseRight]', target: semanticTab })
  expect(local.getByRole('menu')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(local.queryByRole('menu')).not.toBeInTheDocument()
  await user.click(local.getByRole('button', { name: /opened files/i }))
  expect(document.activeElement).toBe(local.getByRole('searchbox'))
  await user.click(document.body)
  expect(local.queryByRole('searchbox')).not.toBeInTheDocument()
})

it('reports rejected context actions without an unhandled promise', async () => {
  const user = userEvent.setup()
  const onError = vi.fn()
  const reveal = vi.fn(async () => { throw new Error('denied') })
  const view = render(<FileTabs tabs={[tab('a', '/a.parquet')]} activeTabId="a" onActivate={vi.fn()} onClose={vi.fn()} onCloseOthers={vi.fn()} onCloseRight={vi.fn()} onReveal={reveal} onError={onError} />)
  const local = within(view.container)
  await user.pointer({ keys: '[MouseRight]', target: local.getByRole('tab') })
  await user.click(local.getByRole('menuitem', { name: /reveal/i }))
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('Reveal file', expect.any(Error)))
})

it('opens and navigates the context menu entirely by keyboard and restores tab focus', async () => {
  const user = userEvent.setup()
  const view = render(<FileTabs tabs={[tab('a', '/a.parquet')]} activeTabId="a" onActivate={vi.fn()} onClose={vi.fn()} onCloseOthers={vi.fn()} onCloseRight={vi.fn()} onReveal={vi.fn()} />)
  const local = within(view.container)
  const semanticTab = local.getByRole('tab')
  vi.spyOn(semanticTab, 'getBoundingClientRect').mockReturnValue({ left: 12, top: 20, right: 112, bottom: 48, width: 100, height: 28, x: 12, y: 20, toJSON: () => ({}) })
  semanticTab.focus()
  fireEvent.keyDown(semanticTab, { key: 'ContextMenu' })
  const items = local.getAllByRole('menuitem')
  expect(document.activeElement).toBe(items[0])
  expect(local.getByRole('menu')).toHaveStyle({ left: '12px', top: '48px' })
  await user.keyboard('{ArrowDown}')
  expect(document.activeElement).toBe(items[1])
  await user.keyboard('{End}')
  expect(document.activeElement).toBe(items[items.length - 1])
  await user.keyboard('{Home}')
  expect(document.activeElement).toBe(items[0])
  await user.keyboard('{ArrowUp}')
  expect(document.activeElement).toBe(items[items.length - 1])
  await user.keyboard('{Escape}')
  expect(local.queryByRole('menu')).not.toBeInTheDocument()
  expect(document.activeElement).toBe(semanticTab)

  fireEvent.keyDown(semanticTab, { key: 'F10', shiftKey: true })
  expect(local.getByRole('menu')).toBeInTheDocument()
})

it('positions pointer context menus at the event coordinates', () => {
  const view = render(<FileTabs tabs={[tab('a', '/a.parquet')]} activeTabId="a" onActivate={vi.fn()} onClose={vi.fn()} onCloseOthers={vi.fn()} onCloseRight={vi.fn()} onReveal={vi.fn()} />)
  const local = within(view.container)
  fireEvent.contextMenu(local.getByRole('tab'), { clientX: 321, clientY: 123 })
  expect(local.getByRole('menu')).toHaveStyle({ left: '321px', top: '123px' })
})
