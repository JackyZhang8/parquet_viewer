import type { AppError, ExportProgress } from '../../domain/types'
import type { QueryStatus } from '../../stores/queryState'

interface Props {
  status: QueryStatus
  elapsedMs: string
  returnedRows: string
  visibleRange: [number, number] | null
  totalRows: number
  loading?: boolean
  truncated?: boolean
  stale?: boolean
  error?: AppError
  onCancel?: () => void
  canExport?: boolean
  exportProgress?: ExportProgress
  onExport?: () => void
  onCancelExport?: () => void
}

export function StatusBar(props: Props) {
  const { status, elapsedMs, returnedRows, visibleRange, totalRows, loading, truncated, stale, error, onCancel,
    canExport, exportProgress, onExport, onCancelExport } = props
  const active = status === 'queued' || status === 'running'
  const label = status.charAt(0).toUpperCase() + status.slice(1)
  return <footer className="status-bar" aria-label="Query status">
    <span className={`query-status query-status-${status}`} role="status" aria-live="polite">
      {(loading || status === 'queued') && <span className="status-spinner" aria-label="Loading batch" />} {label}
    </span>
    <span>{elapsedMs} ms</span><span>{returnedRows} returned</span>
    <span>{visibleRange ? `Rows ${visibleRange[0]}–${visibleRange[1]} of ${totalRows}` : `${totalRows} rows`}</span>
    {truncated && <span className="status-warning">Preview capped</span>}
    {stale && <span className="status-warning">Stale result</span>}
    {error && <span className="status-error" role="alert"><strong>{error.code}</strong>: {error.message}</span>}
    {error && <span>Adjust filters and run again.</span>}
    {active && onCancel && <button type="button" onClick={onCancel} aria-label="Stop query">Stop</button>}
    {canExport && !exportProgress && onExport && <button type="button" onClick={onExport} aria-label="Export CSV">Export CSV</button>}
    {exportProgress && <span role="status" aria-label="Export status" className={`export-status export-status-${exportProgress.status}`}>
      {exportProgress.status === 'queued' ? 'Export queued' : exportProgress.status === 'running' ? 'Exporting…' :
        exportProgress.status === 'completed' ? `${Number(exportProgress.rowsWritten).toLocaleString()} rows exported` :
          exportProgress.status === 'cancelled' ? 'Export cancelled' : 'Export failed'}
    </span>}
    {exportProgress?.status === 'error' && exportProgress.error && <span role="alert" className="status-error">{exportProgress.error.message}</span>}
    {(exportProgress?.status === 'queued' || exportProgress?.status === 'running') && onCancelExport &&
      <button type="button" onClick={onCancelExport} aria-label="Cancel export">Cancel export</button>}
  </footer>
}
