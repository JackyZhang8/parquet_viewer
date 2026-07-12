import { render, screen } from '@testing-library/react'
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
  await user.keyboard('{Delete}')
  expect(close).toHaveBeenCalledWith('a')

  await user.click(screen.getByRole('button', { name: /opened files/i }))
  await user.type(screen.getByRole('searchbox'), 'other')
  await user.click(screen.getByRole('option', { name: /other.parquet/i }))
  expect(activate).toHaveBeenCalledWith('c')

  await user.pointer({ keys: '[MouseRight]', target: first })
  await user.click(screen.getByRole('menuitem', { name: 'Copy path' }))
  expect(writeText).toHaveBeenCalledWith('/one/data.parquet')
  await user.pointer({ keys: '[MouseRight]', target: first })
  await user.click(screen.getByRole('menuitem', { name: 'Reveal in file manager' }))
  expect(reveal).toHaveBeenCalledWith('/one/data.parquet')
})
