import { render, screen } from '@testing-library/react'
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
