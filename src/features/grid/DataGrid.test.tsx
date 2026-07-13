import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { DataGrid } from './DataGrid'

const columns = (count: number) => Array.from({ length: count }, (_, index) => ({
  name: `column_${index}`, logicalType: index % 2 ? 'VARCHAR' : 'INT64', nullable: true,
}))

it('virtualizes both 10k rows and 200 columns with a bounded cell mount', () => {
  const sharedRow = Array.from({ length: 200 }, (_, column) => `value:${column}`)
  const rows = Array.from({ length: 10_000 }, () => sharedRow)
  render(<DataGrid queryKey="done-1" columns={columns(200)} rows={rows} status="done" done />)
  expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '10001')
  expect(screen.getByRole('grid')).toHaveAttribute('aria-colcount', '201')
  expect(screen.getAllByRole('gridcell').length).toBeLessThan(200)
  expect(screen.queryByText('value:199')).not.toBeInTheDocument()
})

it('requests one next batch when scrolling near the running end', async () => {
  const onLoadMore = vi.fn()
  render(<DataGrid queryKey="running-1" columns={columns(3)} rows={Array.from({ length: 100 }, (_, i) => [i, i, i])} status="running" done={false} onLoadMore={onLoadMore} />)
  const grid = screen.getByRole('grid')
  Object.defineProperty(grid, 'scrollHeight', { configurable: true, value: 3000 })
  Object.defineProperty(grid, 'clientHeight', { configurable: true, value: 400 })
  fireEvent.scroll(grid, { target: { scrollTop: 2700 } })
  await waitFor(() => expect(onLoadMore).toHaveBeenCalledTimes(1))
  fireEvent.scroll(grid, { target: { scrollTop: 2701 } })
  expect(onLoadMore).toHaveBeenCalledTimes(1)
})

it('selects a rectangle, copies TSV, and reports clipboard errors safely', async () => {
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  render(<DataGrid queryKey="copy-1" columns={columns(3)} rows={[[1, 'a\tb', null], [2, 'x\ny', true]]} status="done" done />)
  const cells = screen.getAllByRole('gridcell')
  await userEvent.click(cells.find((cell) => cell.textContent === '1')!)
  fireEvent.click(cells.find((cell) => cell.textContent === 'x\ny')!, { shiftKey: true })
  await userEvent.click(screen.getByRole('button', { name: 'Copy selection' }))
  expect(writeText).toHaveBeenCalledWith('1\ta\\tb\n2\tx\\ny')
  expect(screen.getByRole('status')).toHaveTextContent(/copied/i)
  writeText.mockRejectedValueOnce(new Error('denied'))
  await userEvent.click(screen.getByRole('button', { name: 'Copy selection' }))
  expect(screen.getByRole('status')).toHaveTextContent(/could not copy/i)
})

it('supports keyboard navigation, resizing, hiding, and full-value detail', async () => {
  const long = '😀'.repeat(100)
  render(<DataGrid queryKey="detail-1" columns={columns(3)} rows={[[long, { z: 2, a: 1 }, 'last']]} status="done" done />)
  const longCell = screen.getAllByRole('gridcell').find((cell) => cell.textContent?.includes('😀'))!
  await userEvent.click(longCell)
  expect(screen.getByRole('dialog')).toHaveTextContent(long.trim())
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(longCell).toHaveFocus()
  await userEvent.keyboard('{ArrowRight}')
  await waitFor(() => expect(screen.getAllByRole('gridcell').find((cell) => cell.getAttribute('data-cell') === '0:1')).toHaveAttribute('aria-selected', 'true'))

  const handle = screen.getByRole('separator', { name: /resize column_0/i })
  const before = Number(handle.getAttribute('aria-valuenow'))
  handle.focus(); fireEvent.keyDown(handle, { key: 'ArrowRight' })
  await waitFor(() => expect(Number(screen.getByRole('separator', { name: /resize column_0/i }).getAttribute('aria-valuenow'))).toBeGreaterThan(before))
  await userEvent.click(screen.getByRole('button', { name: /columns/i }))
  await userEvent.click(screen.getByRole('checkbox', { name: 'column_1' }))
  expect(screen.queryByRole('columnheader', { name: /column_1/i })).not.toBeInTheDocument()
})

it('resets near-end loading when a replacement query has the same row count', async () => {
  const onLoadMore = vi.fn()
  const rows = Array.from({ length: 100 }, (_, index) => [index])
  const view = render(<DataGrid queryKey="old" columns={columns(1)} rows={rows} status="running" done={false} onLoadMore={onLoadMore} />)
  const grid = screen.getByRole('grid')
  Object.defineProperty(grid, 'scrollHeight', { configurable: true, value: 3000 })
  Object.defineProperty(grid, 'clientHeight', { configurable: true, value: 400 })
  fireEvent.scroll(grid, { target: { scrollTop: 2700 } })
  await waitFor(() => expect(onLoadMore).toHaveBeenCalledTimes(1))
  view.rerender(<DataGrid queryKey="new" columns={columns(1)} rows={rows} status="running" done={false} onLoadMore={onLoadMore} />)
  await waitFor(() => expect(onLoadMore).toHaveBeenCalledTimes(2))
})

it('navigates horizontally through visible columns only', async () => {
  render(<DataGrid queryKey="hidden-nav" columns={columns(3)} rows={[["left", "secret", "right"]]} status="done" done />)
  await userEvent.click(screen.getByRole('button', { name: 'Columns' }))
  await userEvent.click(screen.getByRole('checkbox', { name: 'column_1' }))
  const left = screen.getByRole('gridcell', { name: /column_0.*left/i })
  await userEvent.click(left); await userEvent.keyboard('{ArrowRight}')
  await waitFor(() => expect(screen.getByRole('gridcell', { name: /column_2.*right/i })).toHaveAttribute('aria-selected', 'true'))
})

it('copies rectangular selections from visible columns only', async () => {
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  render(<DataGrid queryKey="hidden-copy" columns={columns(3)} rows={[["left", "secret", "right"]]} status="done" done />)
  await userEvent.click(screen.getByRole('button', { name: 'Columns' }))
  await userEvent.click(screen.getByRole('checkbox', { name: 'column_1' }))
  fireEvent.click(screen.getByRole('gridcell', { name: /column_0.*left/i }))
  fireEvent.click(screen.getByRole('gridcell', { name: /column_2.*right/i }), { shiftKey: true })
  await userEvent.click(screen.getByRole('button', { name: 'Copy selection' }))
  expect(writeText).toHaveBeenCalledWith('left\tright')
})

it('moves focus safely when the focused column becomes hidden', async () => {
  render(<DataGrid queryKey="hidden-focus" columns={columns(3)} rows={[["left", "secret", "right"]]} status="done" done />)
  await userEvent.click(screen.getByRole('gridcell', { name: /column_1.*secret/i }))
  await userEvent.click(screen.getByRole('button', { name: 'Columns' }))
  await userEvent.click(screen.getByRole('checkbox', { name: 'column_1' }))
  await waitFor(() => expect(screen.getByRole('gridcell', { name: /column_2.*right/i })).toHaveAttribute('aria-selected', 'true'))
})

it('recomputes virtual column geometry after keyboard resize', async () => {
  const view = render(<DataGrid queryKey="geometry-key" columns={columns(3)} rows={[[1, 2, 3]]} status="done" done />)
  const body = view.container.querySelector<HTMLElement>('.grid-body')!
  expect(body.style.width).toBe('492px')
  const handle = screen.getByRole('separator', { name: /resize column_0/i })
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  await waitFor(() => {
    expect(view.container.querySelector<HTMLElement>('.grid-body')!.style.width).toBe('504px')
    expect(screen.getByRole('columnheader', { name: /column_1/i })).toHaveStyle({ left: '196px' })
  })
})

it('recomputes geometry after pointer resize and hide/unhide', async () => {
  const view = render(<DataGrid queryKey="geometry-pointer" columns={columns(3)} rows={[[1, 2, 3]]} status="done" done />)
  const handle = screen.getByRole('separator', { name: /resize column_0/i })
  fireEvent.pointerDown(handle, { clientX: 100 }); fireEvent.pointerMove(document, { clientX: 130 }); fireEvent.pointerUp(document)
  await waitFor(() => {
    expect(view.container.querySelector<HTMLElement>('.grid-body')!.style.width).toBe('522px')
    expect(screen.getByRole('columnheader', { name: /column_1/i })).toHaveStyle({ left: '214px' })
  })
  await userEvent.click(screen.getByRole('button', { name: 'Columns' })); await userEvent.click(screen.getByRole('checkbox', { name: 'column_0' }))
  expect(screen.getByRole('columnheader', { name: /column_1/i })).toHaveStyle({ left: '56px' })
  await userEvent.click(screen.getByRole('checkbox', { name: 'column_0' }))
  await waitFor(() => expect(screen.getByRole('columnheader', { name: /column_1/i })).toHaveStyle({ left: '214px' }))
})

it('enters the grid and opens detail using only the keyboard', async () => {
  const long = 'long '.repeat(30)
  render(<DataGrid queryKey="keyboard-entry" columns={columns(2)} rows={[[long, { nested: true }]]} status="done" done />)
  const grid = screen.getByRole('grid'); grid.focus(); await userEvent.keyboard('{ArrowRight}')
  const first = screen.getByRole('gridcell', { name: /column_0/i })
  await waitFor(() => expect(first).toHaveFocus())
  await userEvent.keyboard('{ArrowRight}')
  const nested = screen.getByRole('gridcell', { name: /column_1/i })
  await waitFor(() => expect(nested).toHaveFocus())
  await userEvent.keyboard('{F2}')
  expect(screen.getByRole('dialog')).toHaveTextContent('{"nested":true}')
  await userEvent.keyboard('{Escape}')
  expect(nested).toHaveFocus()
  grid.focus(); await userEvent.keyboard('{Enter}')
  await waitFor(() => expect(first).toHaveFocus())
  await userEvent.keyboard('{Enter}')
  expect(screen.getByRole('dialog')).toHaveTextContent(long.trim())
})

it('indexes virtualized headers and cells by visible ARIA order', async () => {
  render(<DataGrid queryKey="aria" columns={columns(3)} rows={[[1, 2, 3]]} status="done" done />)
  expect(screen.getAllByRole('row')[0]).toHaveAttribute('aria-rowindex', '1')
  expect(screen.getByRole('columnheader', { name: '#' })).toHaveAttribute('aria-colindex', '1')
  expect(screen.getByRole('columnheader', { name: /column_0/i })).toHaveAttribute('aria-colindex', '2')
  expect(screen.getAllByRole('row')[1]).toHaveAttribute('aria-rowindex', '2')
  expect(screen.getByRole('rowheader')).toHaveAttribute('aria-colindex', '1')
  expect(screen.getByRole('gridcell', { name: /column_0/i })).toHaveAttribute('aria-colindex', '2')
  await userEvent.click(screen.getByRole('button', { name: 'Columns' })); await userEvent.click(screen.getByRole('checkbox', { name: 'column_1' }))
  expect(screen.getByRole('columnheader', { name: /column_2/i })).toHaveAttribute('aria-colindex', '3')
  expect(screen.getByRole('gridcell', { name: /column_2/i })).toHaveAttribute('aria-colindex', '3')
})

it('reports the viewport range without virtualizer overscan', async () => {
  const onVisibleRangeChange = vi.fn()
  render(<DataGrid queryKey="range" columns={columns(1)} rows={Array.from({ length: 100 }, (_, index) => [index])} status="done" done onVisibleRangeChange={onVisibleRangeChange} />)
  await waitFor(() => expect(onVisibleRangeChange).toHaveBeenLastCalledWith([1, 12]))
  const grid = screen.getByRole('grid')
  Object.defineProperty(grid, 'clientHeight', { configurable: true, value: 90 })
  fireEvent.scroll(grid, { target: { scrollTop: 300 } })
  await waitFor(() => expect(onVisibleRangeChange).toHaveBeenLastCalledWith([11, 13]))
})

it('shows visible copy success and error feedback', async () => {
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const view = render(<DataGrid queryKey="toast" columns={columns(1)} rows={[[1]]} status="done" done />)
  await userEvent.click(screen.getByRole('gridcell')); await userEvent.click(screen.getByRole('button', { name: 'Copy cell' }))
  expect(view.container.querySelector('.copy-toast-success')).toHaveTextContent('Copied to clipboard')
  writeText.mockRejectedValueOnce(new Error('denied')); await userEvent.click(screen.getByRole('button', { name: 'Copy cell' }))
  expect(view.container.querySelector('.copy-toast-error')).toHaveTextContent('Could not copy to clipboard')
})
