import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer, type Rect, type Virtualizer } from '@tanstack/react-virtual'
import type { CellValue, ColumnSchema } from '../../domain/types'
import type { QueryStatus } from '../../stores/queryState'
import { formatCellValue, formatTsvValue } from './valueFormat'

interface Point { row: number; column: number }
interface Detail { value: CellValue; returnFocus: HTMLElement }
interface Props {
  queryKey: string
  columns: ColumnSchema[]
  rows: CellValue[][]
  status: QueryStatus
  done: boolean
  loading?: boolean
  initialScroll?: { top: number; left: number }
  onScrollChange?: (scroll: { top: number; left: number }) => void
  onLoadMore?: () => void
  onVisibleRangeChange?: (range: [number, number] | null) => void
  onCopyStatus?: (message: string, ok: boolean) => void
}

const ROW_HEIGHT = 30
const ROW_NUMBER_WIDTH = 56
const MIN_WIDTH = 80
const MAX_WIDTH = 480
const defaultWidth = (column: ColumnSchema): number => /(?:INT|DECIMAL|FLOAT|DOUBLE|DATE|TIME|BOOL)/i.test(column.logicalType) ? 128 : 180
const clampWidth = (value: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(value)))
const observeRect = (instance: Virtualizer<HTMLDivElement, Element>, callback: (rect: Rect) => void) => {
  const element = instance.scrollElement
  if (!element) return
  const update = () => callback({ width: element.clientWidth || 800, height: element.clientHeight || 360 })
  update()
  if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', update); return () => window.removeEventListener('resize', update) }
  const observer = new ResizeObserver(update); observer.observe(element); return () => observer.disconnect()
}
const observeOffset = (instance: Virtualizer<HTMLDivElement, Element>, callback: (offset: number, isScrolling: boolean) => void) => {
  const element = instance.scrollElement
  if (!element) return
  const update = () => callback(instance.options.horizontal ? element.scrollLeft : element.scrollTop, true)
  element.addEventListener('scroll', update, { passive: true }); update()
  return () => element.removeEventListener('scroll', update)
}

export function DataGrid(props: Props) {
  const { queryKey, columns, rows, status, done, loading, onLoadMore, onVisibleRangeChange, onCopyStatus } = props
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const lastLoadSize = useRef<number | null>(null)
  const [hidden, setHidden] = useState<Set<number>>(() => new Set())
  const [widths, setWidths] = useState(() => columns.map(defaultWidth))
  const [menuOpen, setMenuOpen] = useState(false)
  const [anchor, setAnchor] = useState<Point | null>(null)
  const [focus, setFocus] = useState<Point | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [copyMessage, setCopyMessage] = useState('')
  const setScrollRef = useCallback((node: HTMLDivElement | null) => { scrollRef.current = node; setScrollElement(node) }, [])
  const visible = useMemo(() => columns.map((column, index) => ({ column, index })).filter(({ index }) => !hidden.has(index)), [columns, hidden])
  const visiblePosition = useCallback((column: number) => visible.findIndex(({ index }) => index === column), [visible])
  useEffect(() => setWidths((current) => columns.map((column, index) => current[index] ?? defaultWidth(column))), [columns])

  const rowVirtualizer = useVirtualizer({
    count: rows.length, getScrollElement: () => scrollElement, estimateSize: () => ROW_HEIGHT,
    overscan: 4, initialRect: { width: 800, height: 360 }, initialOffset: props.initialScroll?.top ?? 0,
    observeElementRect: observeRect, observeElementOffset: observeOffset,
  })
  const columnVirtualizer = useVirtualizer({
    horizontal: true, count: visible.length, getScrollElement: () => scrollElement,
    estimateSize: (index) => widths[visible[index]?.index] ?? 160, overscan: 2,
    initialRect: { width: 800, height: 360 }, initialOffset: props.initialScroll?.left ?? 0,
    observeElementRect: observeRect, observeElementOffset: observeOffset,
  })
  const virtualRows = rowVirtualizer.getVirtualItems()
  const virtualColumns = columnVirtualizer.getVirtualItems()
  const firstRow = virtualRows[0]?.index
  const lastRow = virtualRows.at(-1)?.index

  useEffect(() => {
    const range: [number, number] | null = firstRow === undefined || lastRow === undefined ? null : [firstRow + 1, lastRow + 1]
    onVisibleRangeChange?.(range)
  }, [firstRow, lastRow, onVisibleRangeChange])
  useEffect(() => {
    lastLoadSize.current = null; setAnchor(null); setFocus(null); setDetail(null); setCopyMessage('')
    setHidden(new Set()); setWidths(columns.map(defaultWidth)); setMenuOpen(false)
  }, [queryKey])
  useEffect(() => {
    if (status !== 'running' || done || loading || lastRow === undefined || lastRow < rows.length - 5 || lastLoadSize.current === rows.length) return
    lastLoadSize.current = rows.length; onLoadMore?.()
  }, [done, lastRow, loading, onLoadMore, queryKey, rows.length, status])
  useEffect(() => {
    if (!focus || visiblePosition(focus.column) >= 0) return
    if (!visible.length) { setFocus(null); setAnchor(null); setDetail(null); return }
    const nearest = [...visible].sort((a, b) => Math.abs(a.index - focus.column) - Math.abs(b.index - focus.column) || b.index - a.index)[0]
    const next = { row: focus.row, column: nearest.index }
    setFocus(next); setAnchor(next); setDetail(null)
    requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${next.row}:${next.column}"]`)?.focus())
  }, [focus, visible, visiblePosition])
  useEffect(() => {
    if (!anchor || visiblePosition(anchor.column) >= 0 || !visible.length) return
    const nearest = [...visible].sort((a, b) => Math.abs(a.index - anchor.column) - Math.abs(b.index - anchor.column) || b.index - a.index)[0]
    setAnchor({ row: anchor.row, column: nearest.index })
  }, [anchor, visible, visiblePosition])
  useEffect(() => {
    if (!detail) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setDetail(null); detail.returnFocus.focus() } }
    document.addEventListener('keydown', close); return () => document.removeEventListener('keydown', close)
  }, [detail])

  const selected = (point: Point) => {
    if (!anchor || !focus) return false
    const pointPosition = visiblePosition(point.column); const anchorPosition = visiblePosition(anchor.column); const focusPosition = visiblePosition(focus.column)
    if (pointPosition < 0 || anchorPosition < 0 || focusPosition < 0) return false
    return point.row >= Math.min(anchor.row, focus.row) && point.row <= Math.max(anchor.row, focus.row) &&
      pointPosition >= Math.min(anchorPosition, focusPosition) && pointPosition <= Math.max(anchorPosition, focusPosition)
  }
  const select = (point: Point, shift: boolean, element: HTMLElement) => {
    if (!shift || !anchor) setAnchor(point)
    setFocus(point); element.focus()
  }
  const openDetail = (value: CellValue, element: HTMLElement) => {
    const formatted = formatCellValue(value, 80)
    if (formatted.truncated || formatted.kind === 'nested' || formatted.kind === 'blob') setDetail({ value, returnFocus: element })
  }
  const navigate = (event: React.KeyboardEvent, point: Point) => {
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    const horizontal = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!delta && !horizontal) return
    event.preventDefault()
    const currentVisible = Math.max(0, visiblePosition(point.column))
    const nextVisible = Math.max(0, Math.min(visible.length - 1, currentVisible + horizontal))
    const next = { row: Math.max(0, Math.min(rows.length - 1, point.row + delta)), column: visible[nextVisible]?.index ?? point.column }
    if (!event.shiftKey) setAnchor(next); setFocus(next)
    rowVirtualizer.scrollToIndex(next.row, { align: 'auto' })
    if (nextVisible >= 0) columnVirtualizer.scrollToIndex(nextVisible, { align: 'auto' })
    requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${next.row}:${next.column}"]`)?.focus())
  }
  const copy = async (mode: 'cell' | 'row' | 'selection') => {
    if (!focus) return
    let region: CellValue[][]
    if (mode === 'cell') region = [[rows[focus.row]?.[focus.column] ?? null]]
    else if (mode === 'row') region = [visible.map(({ index }) => rows[focus.row]?.[index] ?? null)]
    else {
      const start = anchor ?? focus
      const rowStart = Math.min(start.row, focus.row); const rowEnd = Math.max(start.row, focus.row)
      const startPosition = visiblePosition(start.column); const focusPosition = visiblePosition(focus.column)
      const selectedColumns = visible.slice(Math.min(startPosition, focusPosition), Math.max(startPosition, focusPosition) + 1)
      region = rows.slice(rowStart, rowEnd + 1).map((row) => selectedColumns.map(({ index }) => row[index] ?? null))
    }
    const text = region.map((row) => row.map(formatTsvValue).join('\t')).join('\n')
    try { await navigator.clipboard.writeText(text); setCopyMessage('Copied to clipboard'); onCopyStatus?.('Copied to clipboard', true) }
    catch { setCopyMessage('Could not copy to clipboard'); onCopyStatus?.('Could not copy to clipboard', false) }
  }
  const resizeKey = (event: React.KeyboardEvent, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault(); setWidths((current) => current.map((width, currentIndex) => currentIndex === index ? clampWidth(width + (event.key === 'ArrowRight' ? 12 : -12)) : width))
  }
  const startResize = (event: React.PointerEvent, index: number) => {
    const start = event.clientX; const original = widths[index]
    const move = (next: PointerEvent) => setWidths((current) => current.map((width, currentIndex) => currentIndex === index ? clampWidth(original + next.clientX - start) : width))
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up) }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
  }
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget
    props.onScrollChange?.({ top: target.scrollTop, left: target.scrollLeft })
    if (status === 'running' && !done && !loading && target.scrollTop + target.clientHeight >= target.scrollHeight - ROW_HEIGHT * 4 && lastLoadSize.current !== rows.length) {
      lastLoadSize.current = rows.length; onLoadMore?.()
    }
  }
  const totalWidth = ROW_NUMBER_WIDTH + columnVirtualizer.getTotalSize()

  return <section className="data-grid-shell">
    <div className="grid-toolbar">
      <button type="button" disabled={!focus} onClick={() => void copy('cell')}>Copy cell</button>
      <button type="button" disabled={!focus} onClick={() => void copy('row')}>Copy row</button>
      <button type="button" disabled={!focus} onClick={() => void copy('selection')}>Copy selection</button>
      <button type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>Columns</button>
      {menuOpen && <fieldset className="column-menu"><legend>Visible columns</legend>{columns.map((column, index) => <label key={column.name}>
        <input type="checkbox" aria-label={column.name} checked={!hidden.has(index)} onChange={() => setHidden((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next })} /> {column.name}
      </label>)}</fieldset>}
    </div>
    <div className="sr-status" role="status" aria-live="polite">{copyMessage}</div>
    <div ref={setScrollRef} className="data-grid" role="grid" tabIndex={0} aria-rowcount={rows.length + 1} aria-colcount={visible.length + 1} onScroll={handleScroll}>
      <div className="grid-header" role="row" style={{ width: totalWidth }}>
        <div className="row-number header-number" role="columnheader">#</div>
        {virtualColumns.map((virtual) => { const item = visible[virtual.index]; const width = widths[item.index]; return <div key={item.index} role="columnheader" className="grid-header-cell" style={{ left: ROW_NUMBER_WIDTH + virtual.start, width }}>
          <span>{item.column.name}</span><small>{item.column.logicalType}</small>
          <span role="separator" tabIndex={0} aria-label={`Resize ${item.column.name}`} aria-orientation="vertical" aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={width} onKeyDown={(event) => resizeKey(event, item.index)} onPointerDown={(event) => startResize(event, item.index)} />
        </div> })}
      </div>
      <div className="grid-body" style={{ height: rowVirtualizer.getTotalSize(), width: totalWidth }}>
        {virtualRows.map((virtualRow) => <div className="grid-row" role="row" key={virtualRow.key} style={{ transform: `translateY(${virtualRow.start}px)`, width: totalWidth }}>
          <div className="row-number" role="rowheader">{virtualRow.index + 1}</div>
          {virtualColumns.map((virtualColumn) => { const item = visible[virtualColumn.index]; const value = rows[virtualRow.index]?.[item.index] ?? null; const formatted = formatCellValue(value, 80); const point = { row: virtualRow.index, column: item.index }; return <div
            key={item.index} role="gridcell" data-cell={`${point.row}:${point.column}`} tabIndex={focus?.row === point.row && focus.column === point.column ? 0 : -1}
            aria-selected={selected(point)} aria-label={`${item.column.name}, row ${point.row + 1}: ${formatted.full}`}
            className={`grid-cell cell-${formatted.kind}${selected(point) ? ' selected' : ''}`}
            style={{ left: ROW_NUMBER_WIDTH + virtualColumn.start, width: widths[item.index] }}
            onClick={(event) => { select(point, event.shiftKey, event.currentTarget); openDetail(value, event.currentTarget) }} onKeyDown={(event) => navigate(event, point)}
          >{formatted.display}</div> })}
        </div>)}
      </div>
    </div>
    {detail && <div className="cell-detail" role="dialog" aria-modal="true" aria-label="Cell detail"><header><strong>Cell value</strong><button autoFocus type="button" aria-label="Close detail" onClick={() => { const target = detail.returnFocus; setDetail(null); target.focus() }}>×</button></header><pre>{formatCellValue(detail.value, Number.MAX_SAFE_INTEGER).full}</pre></div>}
  </section>
}
