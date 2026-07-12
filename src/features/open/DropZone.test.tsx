import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { DropZone } from './DropZone'

it('opens all picked paths and treats picker cancellation as a no-op', async () => {
  const pick = vi.fn().mockResolvedValueOnce(['/a.parquet', '/b.parquet']).mockResolvedValueOnce(null)
  const onOpen = vi.fn()
  const user = userEvent.setup()
  render(<DropZone pickFiles={pick} onOpen={onOpen} />)
  await user.click(screen.getByRole('button', { name: /open parquet files/i }))
  expect(onOpen).toHaveBeenCalledWith(['/a.parquet', '/b.parquet'])
  await user.click(screen.getByRole('button', { name: /open parquet files/i }))
  expect(onOpen).toHaveBeenCalledTimes(1)
})
