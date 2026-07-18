import { render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'

import { StatsPanel } from './StatsPanel'

it('shows a compact file size on a second line below exact bytes', () => {
  render(<StatsPanel id="statistics" onClose={() => undefined} metadata={{
    fileId: 'file-1', path: '/data/events.parquet', name: 'events.parquet', sizeBytes: '53583206', rowCount: '1', rowGroupCount: 1, columns: [],
  }} />)

  const size = screen.getByText('File size').parentElement!
  expect(within(size).getByText('53,583,206 bytes')).toBeInTheDocument()
  expect(within(size).getByText('51.1 MB')).toBeInTheDocument()
})
