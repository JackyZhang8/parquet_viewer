import type { AppError } from '../../domain/types'
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
}

export function StatusBar(props: Props) {
  const { status, elapsedMs, returnedRows, visibleRange, totalRows, loading, truncated, stale, error, onCancel } = props
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
  </footer>
}
