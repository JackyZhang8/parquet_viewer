import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { StatusBar } from './StatusBar'

it('announces progress, visible range, truncation, and offers stop', async () => {
  const onCancel = vi.fn()
  render(<StatusBar status="running" elapsedMs="42" returnedRows="500" visibleRange={[21, 40]} totalRows={500} loading truncated stale onCancel={onCancel} />)
  expect(screen.getByRole('status')).toHaveTextContent(/running/i)
  expect(screen.getByText(/rows 21–40 of 500/i)).toBeInTheDocument()
  expect(screen.getByText(/preview capped/i)).toBeInTheDocument()
  expect(screen.getByText(/stale/i)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /stop query/i }))
  expect(onCancel).toHaveBeenCalledOnce()
})

it('shows sanitized query errors and a retry hint', () => {
  render(<StatusBar status="error" elapsedMs="0" returnedRows="0" visibleRange={null} totalRows={0} error={{ code: 'SQL_ERROR', message: 'Unknown column', detail: null }} />)
  expect(screen.getByRole('alert')).toHaveTextContent(/SQL_ERROR.*Unknown column/i)
  expect(screen.getByText(/adjust filters and run again/i)).toBeInTheDocument()
})

it('labels queued work and offers a stop action', async () => {
  const onCancel = vi.fn()
  render(<StatusBar status="queued" elapsedMs="0" returnedRows="0" visibleRange={null} totalRows={0} onCancel={onCancel} />)
  expect(screen.getByRole('status')).toHaveTextContent('Queued')
  await userEvent.click(screen.getByRole('button', { name: /stop query/i }))
  expect(onCancel).toHaveBeenCalledOnce()
})

it('starts export for a completed query and exposes export cancellation while running', async () => {
  const onExport = vi.fn()
  const onCancelExport = vi.fn()
  const view = render(<StatusBar status="done" elapsedMs="4" returnedRows="20" visibleRange={[1, 20]} totalRows={20} canExport onExport={onExport} />)
  await userEvent.click(screen.getByRole('button', { name: /export csv/i }))
  expect(onExport).toHaveBeenCalledOnce()

  view.rerender(<StatusBar status="done" elapsedMs="4" returnedRows="20" visibleRange={[1, 20]} totalRows={20}
    exportProgress={{ exportId: 'export-1', status: 'running', rowsWritten: '0', error: null }} onCancelExport={onCancelExport} />)
  expect(screen.getByRole('status', { name: /export status/i })).toHaveTextContent(/exporting/i)
  await userEvent.click(screen.getByRole('button', { name: /cancel export/i }))
  expect(onCancelExport).toHaveBeenCalledOnce()
})

it('reports completed export rows and sanitized export errors', () => {
  const view = render(<StatusBar status="done" elapsedMs="4" returnedRows="20" visibleRange={null} totalRows={20}
    exportProgress={{ exportId: 'export-1', status: 'completed', rowsWritten: '12500', error: null }} />)
  expect(screen.getByRole('status', { name: /export status/i })).toHaveTextContent(/12,500 rows/i)
  view.rerender(<StatusBar status="done" elapsedMs="4" returnedRows="20" visibleRange={null} totalRows={20}
    exportProgress={{ exportId: 'export-1', status: 'error', rowsWritten: '0', error: { code: 'RESOURCE_EXHAUSTED', message: 'Disk full', detail: null } }} />)
  expect(screen.getByRole('alert')).toHaveTextContent(/disk full/i)
})

it('renders determinate progress for an inspected export', () => {
  const props = {
    status: 'done', elapsedMs: '4', returnedRows: '20', visibleRange: null, totalRows: 20,
    exportProgress: { exportId: 'export-1', status: 'running', rowsWritten: '25000', error: null },
    exportTotalRows: '100000',
  } as unknown as ComponentProps<typeof StatusBar>

  render(<StatusBar {...props} />)

  expect(screen.getByRole('progressbar', { name: /csv export progress/i })).toHaveAttribute('value', '25')
  expect(screen.getByRole('status', { name: /export status/i })).toHaveTextContent(/25,000 of 100,000/i)
})

it('announces export size inspection before a potentially large export', () => {
  const props = {
    status: 'done', elapsedMs: '4', returnedRows: '20', visibleRange: null, totalRows: 20,
    canExport: true, exportPreparing: true,
  } as unknown as ComponentProps<typeof StatusBar>

  render(<StatusBar {...props} />)

  expect(screen.getByRole('status', { name: /export preparation/i })).toHaveTextContent(/checking export size/i)
  expect(screen.queryByRole('button', { name: /export csv/i })).not.toBeInTheDocument()
})
