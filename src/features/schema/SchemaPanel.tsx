import { useEffect, useMemo, useRef, useState } from 'react'
import type { ColumnSchema, FileMetadata } from '../../domain/types'
import { columnFamily } from '../query/filterSql'

interface Props {
  metadata?: FileMetadata
  state?: 'ready' | 'loading' | 'unavailable' | 'error'
  width: number
  onWidthChange(width: number): void
  onError(error: unknown): void
}

const ROW_HEIGHT = 44
const WINDOW_ROWS = 14
const OVERSCAN = 2
const count = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const familyLabel = (kind: ReturnType<typeof columnFamily>['kind']) => {
  const labels: Partial<Record<ReturnType<typeof columnFamily>['kind'], string>> = {
    signedInteger: 'integer', unsignedInteger: 'unsigned',
  }
  return labels[kind] ?? kind
}

function Field({ column, onCopy }: { column: ColumnSchema; onCopy(name: string): void }) {
  const family = columnFamily(column)
  const nullability = column.nullable ? 'nullable' : 'required'
  return <button className="schema-field" aria-label={`Copy field ${column.name}, ${column.logicalType}, ${nullability}`} onClick={() => onCopy(column.name)}>
    <span className="family-icon" aria-hidden="true">{familyLabel(family.kind).slice(0,1).toUpperCase()}</span>
    <span><strong>{column.name}</strong><small>{column.logicalType} · {nullability} · {familyLabel(family.kind)}</small></span>
  </button>
}

export function SchemaPanel({ metadata, state = 'ready', width, onWidthChange, onError }: Props) {
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [announcement, setAnnouncement] = useState('')
  const expandRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const columns = useMemo(() => {
    const query = search.toLowerCase()
    return metadata?.columns.filter((column) => column.name.toLowerCase().includes(query)) ?? []
  }, [metadata?.columns, search])
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(columns.length, start + WINDOW_ROWS + OVERSCAN * 2)
  const visible = columns.slice(start, end)

  useEffect(() => { if (collapsed) expandRef.current?.focus() }, [collapsed])
  const updateSearch = (value: string) => {
    setSearch(value); setScrollTop(0); setAnnouncement('')
    if (listRef.current) listRef.current.scrollTop = 0
  }
  const copy = async (name: string) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard is unavailable')
      await navigator.clipboard.writeText(name); setAnnouncement(`Copied ${name}`)
    } catch (error) { setAnnouncement(''); onError(error) }
  }

  if (collapsed) return <aside className="schema-panel collapsed">
    <button ref={expandRef} aria-label="Expand schema" onClick={() => setCollapsed(false)}>›</button>
  </aside>
  return <aside className="schema-panel" style={{ width }}>
    <div className="schema-heading">
      <strong>Schema</strong><button aria-label="Collapse schema" onClick={() => setCollapsed(true)}>‹</button>
    </div>
    {state === 'loading' && <p role="status">Loading schema…</p>}
    {state === 'unavailable' && <p>File unavailable</p>}
    {state === 'error' && <p role="alert">Schema could not be loaded</p>}
    {state === 'ready' && metadata && <>
      <div className="schema-file" title={metadata.path}>
        <strong>{metadata.name}</strong><span>{count(metadata.sizeBytes)} bytes</span>
      </div>
      <div className="schema-stats">
        <span>{count(metadata.rowCount)} rows</span><span>{metadata.columns.length} columns</span>
        <span>{metadata.rowGroupCount} row groups</span>
      </div>
      <label className="schema-search">Search fields<input type="search" aria-label="Search fields" value={search} onChange={(event) => updateSearch(event.target.value)} /></label>
      <div ref={listRef} className="schema-fields" role="list" aria-label="Schema fields"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        {columns.length > 0 && <div className="schema-fields-window" style={{ height: columns.length * ROW_HEIGHT }}>
          <div style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
            {visible.map((column) => <Field key={column.name} column={column} onCopy={(name) => void copy(name)} />)}
          </div>
        </div>}
        {metadata.columns.length === 0 && <p>No columns found</p>}
        {metadata.columns.length > 0 && columns.length === 0 && <p>No matching fields</p>}
      </div>
      {announcement && <p className="sr-status" role="status" aria-live="polite">{announcement}</p>}
      <label className="schema-width">Sidebar width<input aria-label="Sidebar width" type="range"
        min="200" max="480" value={width} onChange={(event) => onWidthChange(Number(event.target.value))} />
      </label>
    </>}
  </aside>
}
