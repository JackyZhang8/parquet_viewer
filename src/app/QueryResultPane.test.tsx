import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { QueryResultPane } from './QueryResultPane'

it('shows the file row count for the initial preview', async () => {
  render(<QueryResultPane
    query={{
      source: 'filter',
      submittedFilter: { selectedColumns: [], filters: [], sorts: [], previewLimit: 1_000 },
      hasSuccessfulResult: true,
      status: 'done',
      queryId: 'preview',
      columns: [{ name: 'id', logicalType: 'INT64', nullable: false }],
      rows: [[1]],
      done: true,
      returnedRows: '1000',
      elapsedMs: '42',
      loadingBatch: false,
      truncated: true,
      stale: false,
      generation: 1,
    }}
    fileRowCount="12500"
    initialScroll={{ top: 0, left: 0 }}
    onScrollChange={vi.fn()}
    onLoadMore={vi.fn()}
    onRefresh={vi.fn()}
    onCancel={vi.fn()}
    onExport={vi.fn()}
    onCancelExport={vi.fn()}
  />)

  expect(await screen.findByText(/rows 1–1 of 12,500/i)).toBeInTheDocument()
})

it('keeps the loaded result count for filtered queries', async () => {
  render(<QueryResultPane
    query={{
      source: 'filter',
      submittedFilter: {
        selectedColumns: [],
        filters: [{ column: 'id', operator: 'eq', value: { type: 'number', value: 1 } }],
        sorts: [],
        previewLimit: 1_000,
      },
      hasSuccessfulResult: true,
      status: 'done',
      queryId: 'filtered',
      columns: [{ name: 'id', logicalType: 'INT64', nullable: false }],
      rows: [[1]],
      done: true,
      returnedRows: '1',
      elapsedMs: '42',
      loadingBatch: false,
      truncated: false,
      stale: false,
      generation: 1,
    }}
    fileRowCount="12500"
    initialScroll={{ top: 0, left: 0 }}
    onScrollChange={vi.fn()}
    onLoadMore={vi.fn()}
    onRefresh={vi.fn()}
    onCancel={vi.fn()}
    onExport={vi.fn()}
    onCancelExport={vi.fn()}
  />)

  expect(await screen.findByText(/rows 1–1 of 1/i)).toBeInTheDocument()
})
