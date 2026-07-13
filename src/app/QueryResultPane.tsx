import { useState } from 'react'
import { DataGrid } from '../features/grid/DataGrid'
import { StatusBar } from '../features/status/StatusBar'
import type { QueryViewState } from '../stores/queryState'

interface Props {
  query?: QueryViewState
  initialScroll: { top: number; left: number }
  onScrollChange(scroll: { top: number; left: number }): void
  onLoadMore(): void
  onCancel(): void
}

export function QueryResultPane({ query, initialScroll, onScrollChange, onLoadMore, onCancel }: Props) {
  const [visibleRange, setVisibleRange] = useState<[number, number] | null>(null)
  if (!query || query.status === 'idle') return <div className="result-placeholder"><strong>No query result</strong><p>Run filters to preview rows.</p></div>
  return <div className="result-pane">
    <DataGrid columns={query.columns} rows={query.rows} status={query.status} done={query.done} loading={query.loadingBatch}
      initialScroll={initialScroll} onScrollChange={onScrollChange} onLoadMore={onLoadMore} onVisibleRangeChange={setVisibleRange} />
    <StatusBar status={query.status} elapsedMs={query.elapsedMs} returnedRows={query.returnedRows}
      visibleRange={visibleRange} totalRows={query.rows.length} loading={query.loadingBatch} truncated={query.truncated}
      stale={query.stale} error={query.error} onCancel={onCancel} />
  </div>
}
