import { useState } from 'react'
import { DataGrid } from '../features/grid/DataGrid'
import { StatusBar } from '../features/status/StatusBar'
import type { QueryViewState } from '../stores/queryState'
import type { AppLanguage, ExportProgress } from '../domain/types'

interface Props {
  query?: QueryViewState
  initialScroll: { top: number; left: number }
  onScrollChange(scroll: { top: number; left: number }): void
  onLoadMore(): void
  onRefresh(): void
  onCancel(): void
  exportProgress?: ExportProgress
  exportTotalRows?: string
  exportPreparing?: boolean
  onExport(): void
  onCancelExport(): void
  hiddenColumnNames?: ReadonlySet<string>
  onHiddenColumnNamesChange?(next: Set<string>): void
  language?: AppLanguage
}

export function QueryResultPane({ query, initialScroll, onScrollChange, onLoadMore, onRefresh, onCancel, exportProgress, exportTotalRows, exportPreparing, onExport, onCancelExport, hiddenColumnNames, onHiddenColumnNamesChange, language }: Props) {
  const [visibleRange, setVisibleRange] = useState<[number, number] | null>(null)
  if (!query || query.status === 'idle') return <div className="result-placeholder"><strong>No query result</strong><p>Run a query to preview rows.</p></div>
  return <div className="result-pane">
    <DataGrid queryKey={`${query.generation}:${query.queryId ?? 'queued'}`} columns={query.columns} rows={query.rows} status={query.status} done={query.done} loading={query.loadingBatch}
      initialScroll={initialScroll} onScrollChange={onScrollChange} onLoadMore={onLoadMore} onVisibleRangeChange={setVisibleRange}
      hiddenColumnNames={hiddenColumnNames} onHiddenColumnNamesChange={onHiddenColumnNamesChange} onRefresh={onRefresh} language={language} />
    <StatusBar status={query.status} elapsedMs={query.elapsedMs} returnedRows={query.returnedRows}
      visibleRange={visibleRange} totalRows={query.rows.length} loading={query.loadingBatch} truncated={query.truncated}
      stale={query.stale} error={query.error} onCancel={onCancel}
      canExport={query.hasSuccessfulResult && !query.stale && ((query.source === 'sql' && Boolean(query.submittedSql)) || (query.source === 'filter' && Boolean(query.submittedFilter)))}
      exportProgress={exportProgress} exportTotalRows={exportTotalRows} exportPreparing={exportPreparing}
      onExport={onExport} onCancelExport={onCancelExport} />
  </div>
}
