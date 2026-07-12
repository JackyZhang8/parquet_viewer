import { useState } from 'react'
import type { FileMetadata } from '../../domain/types'
import { columnFamily } from '../query/filterSql'

interface Props {
  metadata?: FileMetadata
  state?: 'ready' | 'loading' | 'unavailable' | 'error'
  width: number
  onWidthChange(width: number): void
  onError(error: unknown): void
}

const count = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const familyLabel = (kind: ReturnType<typeof columnFamily>['kind']) => {
  const labels: Partial<Record<ReturnType<typeof columnFamily>['kind'], string>> = { signedInteger:'integer', unsignedInteger:'unsigned', unsupported:'other' }
  return labels[kind] ?? kind
}

export function SchemaPanel({ metadata, state = 'ready', width, onWidthChange, onError }: Props) {
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  if (collapsed) return <aside className="schema-panel collapsed"><button aria-label="Expand schema" onClick={() => setCollapsed(false)}>›</button></aside>
  const columns = metadata?.columns.filter((column) => column.name.toLowerCase().includes(search.toLowerCase())) ?? []
  const copy = async (name: string) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard is unavailable')
      await navigator.clipboard.writeText(name)
    } catch (error) { onError(error) }
  }
  return <aside className="schema-panel" style={{ width }}>
    <div className="schema-heading"><strong>Schema</strong><button aria-label="Collapse schema" onClick={() => setCollapsed(true)}>‹</button></div>
    {state === 'loading' && <p role="status">Loading schema…</p>}
    {state === 'unavailable' && <p>File unavailable</p>}
    {state === 'error' && <p role="alert">Schema could not be loaded</p>}
    {state === 'ready' && metadata && <>
      <div className="schema-file" title={metadata.path}><strong>{metadata.name}</strong><span>{count(metadata.sizeBytes)} bytes</span></div>
      <div className="schema-stats"><span>{count(metadata.rowCount)} rows</span><span>{metadata.columns.length} columns</span><span>{metadata.rowGroupCount} row groups</span></div>
      <label className="schema-search">Search fields<input type="search" aria-label="Search fields" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="schema-fields">{columns.map((column) => { const family = columnFamily(column); return <button key={column.name} className="schema-field" aria-label={`Copy ${column.name}`} onClick={() => void copy(column.name)}>
        <span className="family-icon" aria-hidden="true">{familyLabel(family.kind).slice(0,1).toUpperCase()}</span><span><strong>{column.name}</strong><small>{column.logicalType} · {column.nullable ? 'nullable' : 'required'} · {familyLabel(family.kind)}</small></span>
      </button>})}{metadata.columns.length === 0 && <p>No columns found</p>}{metadata.columns.length > 0 && columns.length === 0 && <p>No matching fields</p>}</div>
      <label className="schema-width">Sidebar width<input aria-label="Sidebar width" type="range" min="200" max="480" value={width} onChange={(event) => onWidthChange(Number(event.target.value))} /></label>
    </>}
  </aside>
}
