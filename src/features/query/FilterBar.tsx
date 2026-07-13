import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ColumnSchema, FilterOperator, FilterQueryRequest, SessionFilter, SessionScalar, SessionSort,
} from '../../domain/types'
import { buildFilterQueryRequest, columnFamily, convertEditorValue, operatorsFor } from './filterSql'

interface Props {
  columns: ColumnSchema[]
  filters: SessionFilter[]
  sorts: SessionSort[]
  onFiltersChange(filters: SessionFilter[]): void
  onSortsChange(sorts: SessionSort[]): void
  onRun(request: FilterQueryRequest): void
}

const labels: Record<FilterOperator, string> = {
  eq: 'equals', notEq: 'does not equal', lt: 'less than', lte: 'less than or equal',
  gt: 'greater than', gte: 'greater than or equal', contains: 'contains',
  startsWith: 'starts with', endsWith: 'ends with', isNull: 'is null', isNotNull: 'is not null',
}
const firstOperator = (column?: ColumnSchema): FilterOperator =>
  column ? operatorsFor(column)[0] ?? 'isNull' : 'isNull'
const scalarLabel = (value: SessionScalar) => value.type === 'null' ? 'NULL' : String(value.value)

export function FilterBar(props: Props) {
  const { columns, filters, sorts, onFiltersChange, onSortsChange, onRun } = props
  const [columnName, setColumnName] = useState(columns[0]?.name ?? '')
  const [operator, setOperator] = useState<FilterOperator>(() => firstOperator(columns[0]))
  const [raw, setRaw] = useState('')
  const [error, setError] = useState('')
  const [previewLimit, setPreviewLimit] = useState(10000)
  const [sortColumn, setSortColumn] = useState(columns[0]?.name ?? '')
  const [draftSorts, setDraftSorts] = useState(sorts)
  const [focusSortIndex, setFocusSortIndex] = useState<number | null>(null)
  const addConditionRef = useRef<HTMLButtonElement>(null)
  const addSortRef = useRef<HTMLButtonElement>(null)
  const sortColumnRef = useRef<HTMLSelectElement>(null)
  const sortListRef = useRef<HTMLOListElement>(null)
  const column = columns.find((item) => item.name === columnName) ?? columns[0]
  const operators = useMemo(() => column ? operatorsFor(column) : [], [column])
  const nullOperator = operator === 'isNull' || operator === 'isNotNull'

  useEffect(() => setDraftSorts(sorts), [sorts])
  useEffect(() => {
    if (focusSortIndex === null) return
    const removers = sortListRef.current?.querySelectorAll<HTMLButtonElement>('button[aria-label^="Remove "]')
    const nearest = removers?.[Math.min(focusSortIndex, removers.length - 1)]
    if (nearest) nearest.focus()
    else if (addSortRef.current && !addSortRef.current.disabled) addSortRef.current.focus()
    else sortColumnRef.current?.focus()
    setFocusSortIndex(null)
  }, [draftSorts, focusSortIndex])
  useEffect(() => {
    const next = columns.find((item) => item.name === columnName) ?? columns[0]
    if (!next) { setColumnName(''); setOperator('isNull'); setSortColumn(''); return }
    if (next.name !== columnName) { setColumnName(next.name); setOperator(firstOperator(next)) }
    else if (!operatorsFor(next).includes(operator)) setOperator(firstOperator(next))
    if (!columns.some((item) => item.name === sortColumn)) setSortColumn(columns[0]?.name ?? '')
  }, [columns, columnName, operator, sortColumn])

  const changeColumn = (name: string) => {
    const next = columns.find((item) => item.name === name)
    setColumnName(name); setRaw(''); setError(''); setOperator(firstOperator(next))
  }
  const addCondition = () => {
    if (!column) return
    try {
      const value = nullOperator ? { type: 'null' as const } : convertEditorValue(column, raw)
      onFiltersChange([...filters, { column: column.name, operator, value }])
      setRaw(''); setError('')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Invalid filter value') }
  }
  const removeCondition = (index: number) => {
    setError(''); onFiltersChange(filters.filter((_, current) => current !== index)); addConditionRef.current?.focus()
  }
  const clearFilters = () => { setError(''); onFiltersChange([]); addConditionRef.current?.focus() }
  const updateSorts = (next: SessionSort[]) => { setDraftSorts(next); onSortsChange(next) }
  const addSort = () => {
    if (!sortColumn || draftSorts.length >= 3 || draftSorts.some((sort) => sort.column === sortColumn)) return
    updateSorts([...draftSorts, { column: sortColumn, direction: 'asc' }])
  }
  const removeSort = (index: number) => {
    setError(''); setFocusSortIndex(index); updateSorts(draftSorts.filter((_, current) => current !== index))
  }
  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= draftSorts.length) return
    const next = [...draftSorts]; [next[index], next[target]] = [next[target], next[index]]; updateSorts(next)
  }
  const run = () => {
    try {
      const request = buildFilterQueryRequest(columns, filters, draftSorts, previewLimit)
      onFiltersChange(filters); onSortsChange(draftSorts); setError(''); onRun(request)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Filters are invalid') }
  }
  const family = column ? columnFamily(column).kind : 'unsupported'

  return <section className="filter-bar" aria-label="Filter query">
    <div className="condition-list">{filters.map((filter, index) =>
      <span className="condition-chip" key={`${filter.column}-${index}`}>
        {filter.column} {labels[filter.operator]} {scalarLabel(filter.value)}
        <button aria-label={`Remove ${filter.column} condition`} onClick={() => removeCondition(index)}>×</button>
      </span>)}</div>
    <div className="filter-editor">
      <label>Column<select aria-label="Filter column" value={columnName} onChange={(event) => changeColumn(event.target.value)}>
        {columns.map((item) => <option key={item.name}>{item.name}</option>)}
      </select></label>
      <label>Operator<select aria-label="Filter operator" value={operator} onChange={(event) => { setOperator(event.target.value as FilterOperator); setError('') }}>
        {operators.map((item) => <option key={item} value={item}>{labels[item]}</option>)}
      </select></label>
      {!nullOperator && family === 'boolean' && <label>Value<select aria-label="Filter value" value={raw} onChange={(event) => { setRaw(event.target.value); setError('') }}>
        <option value="">Choose…</option><option value="true">true</option><option value="false">false</option>
      </select></label>}
      {!nullOperator && family !== 'boolean' && <label>Value<input
        aria-label="Filter value" type="text" value={raw}
        inputMode={['signedInteger','unsignedInteger','decimal','float'].includes(family) ? 'decimal' : undefined}
        onChange={(event) => { setRaw(event.target.value); setError('') }}
      /></label>}
      <button ref={addConditionRef} onClick={addCondition} aria-label="Add condition">Add condition</button>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="sort-editor"><strong>Sort</strong><label>Column<select ref={sortColumnRef} aria-label="Sort column" value={sortColumn} onChange={(event) => { setSortColumn(event.target.value); setError('') }}>
      {columns.map((item) => <option key={item.name} value={item.name} disabled={draftSorts.some((sort) => sort.column === item.name)}>{item.name}</option>)}
    </select></label><button ref={addSortRef} aria-label="Add sort" disabled={draftSorts.length >= 3 || draftSorts.some((sort) => sort.column === sortColumn)} onClick={addSort}>Add sort</button></div>
    <ol ref={sortListRef} className="sort-list">{draftSorts.map((sort, index) => <li key={sort.column}>
      <span>{index + 1}. {sort.column}</span>
      <select aria-label={`${sort.column} direction`} value={sort.direction} onChange={(event) => updateSorts(draftSorts.map((item, current) => current === index ? {...item, direction:event.target.value as 'asc'|'desc'} : item))}>
        <option value="asc">Ascending</option><option value="desc">Descending</option>
      </select>
      <button aria-label={`Move ${sort.column} up`} disabled={index === 0} onClick={() => move(index,-1)}>↑</button>
      <button aria-label={`Move ${sort.column} down`} disabled={index === draftSorts.length - 1} onClick={() => move(index,1)}>↓</button>
      <button aria-label={`Remove ${sort.column} sort`} onClick={() => removeSort(index)}>×</button>
    </li>)}</ol>
    <div className="filter-actions">
      <button aria-label="Clear filters" onClick={clearFilters}>Clear filters</button>
      <label>Preview rows<input aria-label="Preview rows" type="number" min="1" max="10000" value={previewLimit} onChange={(event) => { setPreviewLimit(Number(event.target.value)); setError('') }} /></label>
      <button className="primary-button" aria-label="Run filters" onClick={run}>Run</button>
    </div>
  </section>
}
