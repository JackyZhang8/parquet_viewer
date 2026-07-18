import { useEffect, useMemo, useRef, useState } from 'react'
import { labelsFor } from '../../app/labels'
import type {
  AppLanguage, ColumnSchema, FilterOperator, FilterQueryRequest, SessionFilter, SessionScalar,
} from '../../domain/types'
import { buildFilterQueryRequest, columnFamily, convertEditorValue, operatorsFor } from './filterSql'

interface Props {
  columns: ColumnSchema[]
  filters: SessionFilter[]
  onFiltersChange(filters: SessionFilter[]): void
  onRun(request: FilterQueryRequest): void
  initialPreviewLimit?: number
  language?: AppLanguage
}

interface AppliedFilterChipsProps {
  filters: SessionFilter[]
  language?: AppLanguage
  onRemove(index: number): void
  onClear(): void
}

const firstOperator = (column?: ColumnSchema): FilterOperator =>
  column ? operatorsFor(column)[0] ?? 'isNull' : 'isNull'
const scalarLabel = (value: SessionScalar) => value.type === 'null' ? 'NULL' : String(value.value)

export function AppliedFilterChips({ filters, language = 'en', onRemove, onClear }: AppliedFilterChipsProps) {
  const copy = labelsFor(language)
  if (!filters.length) return null
  return <section className="filter-summary" role="region" aria-label={copy.activeFilters}>
    <div className="condition-list">{filters.map((filter, index) => <span className="condition-chip" key={`${filter.column}-${index}`}>
      {filter.column} {copy.filterOperators[filter.operator]} {scalarLabel(filter.value)}
      <button type="button" aria-label={copy.removeFilterCondition(filter.column)} onClick={() => onRemove(index)}>×</button>
    </span>)}</div>
    <button type="button" className="filter-clear-button" onClick={onClear}>{copy.clearFilters}</button>
  </section>
}

export function FilterBar(props: Props) {
  const { columns, filters, onFiltersChange, onRun, initialPreviewLimit = 10_000, language = 'en' } = props
  const copy = labelsFor(language)
  const [draftFilters, setDraftFilters] = useState(filters)
  const [columnName, setColumnName] = useState(columns[0]?.name ?? '')
  const [operator, setOperator] = useState<FilterOperator>(() => firstOperator(columns[0]))
  const [raw, setRaw] = useState('')
  const [error, setError] = useState('')
  const [previewLimit, setPreviewLimit] = useState(initialPreviewLimit)
  const addConditionRef = useRef<HTMLButtonElement>(null)
  const column = columns.find((item) => item.name === columnName) ?? columns[0]
  const operators = useMemo(() => column ? operatorsFor(column) : [], [column])
  const nullOperator = operator === 'isNull' || operator === 'isNotNull'
  const family = column ? columnFamily(column).kind : 'unsupported'

  useEffect(() => setDraftFilters(filters), [filters])
  useEffect(() => setPreviewLimit(initialPreviewLimit), [initialPreviewLimit])
  useEffect(() => {
    const next = columns.find((item) => item.name === columnName) ?? columns[0]
    if (!next) { setColumnName(''); setOperator('isNull'); return }
    if (next.name !== columnName) { setColumnName(next.name); setOperator(firstOperator(next)) }
    else if (!operatorsFor(next).includes(operator)) setOperator(firstOperator(next))
  }, [columns, columnName, operator])

  const changeColumn = (name: string) => {
    const next = columns.find((item) => item.name === name)
    setColumnName(name); setRaw(''); setError(''); setOperator(firstOperator(next))
  }
  const addCondition = () => {
    if (!column) return
    try {
      const value = nullOperator ? { type: 'null' as const } : convertEditorValue(column, raw)
      setDraftFilters((current) => [...current, { column: column.name, operator, value }])
      setRaw(''); setError('')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Invalid filter value') }
  }
  const submitFilters = (nextFilters: SessionFilter[]) => {
    try {
      const request = buildFilterQueryRequest(columns, nextFilters, [], previewLimit)
      onFiltersChange(nextFilters); setError(''); onRun(request)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Filters are invalid') }
  }
  const removeCondition = (index: number) => {
    const nextFilters = draftFilters.filter((_, currentIndex) => currentIndex !== index)
    setDraftFilters(nextFilters); submitFilters(nextFilters); addConditionRef.current?.focus()
  }
  const clearFilters = () => { setError(''); setDraftFilters([]); addConditionRef.current?.focus() }
  const run = () => submitFilters(draftFilters)

  return <section className="filter-bar" role="region" aria-label={copy.filterQuery}>
    <div className="filter-builder" role="group" aria-label={copy.filterBuilder}>
      <label>{copy.filterColumn}<select className="filter-select" aria-label={copy.filterColumn} value={columnName} onChange={(event) => changeColumn(event.target.value)}>
        {columns.map((item) => <option key={item.name}>{item.name}</option>)}
      </select></label>
      <label>{copy.filterOperator}<select className="filter-select" aria-label={copy.filterOperator} value={operator} onChange={(event) => { setOperator(event.target.value as FilterOperator); setError('') }}>
        {operators.map((item) => <option key={item} value={item}>{copy.filterOperators[item]}</option>)}
      </select></label>
      {!nullOperator && family === 'boolean' && <label>{copy.filterValue}<select className="filter-select" aria-label={copy.filterValue} value={raw} onChange={(event) => { setRaw(event.target.value); setError('') }}>
        <option value="">{copy.choose}</option><option value="true">true</option><option value="false">false</option>
      </select></label>}
      {!nullOperator && family !== 'boolean' && <label>{copy.filterValue}<input
        aria-label={copy.filterValue} type="text" value={raw}
        inputMode={['signedInteger', 'unsignedInteger', 'decimal', 'float'].includes(family) ? 'decimal' : undefined}
        onChange={(event) => { setRaw(event.target.value); setError('') }}
      /></label>}
      <button ref={addConditionRef} type="button" onClick={addCondition} aria-label={copy.addCondition}>{copy.addCondition}</button>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <section className="filter-draft-list" role="region" aria-label={copy.filterConditions}>
      <strong>{copy.filterConditions}</strong>
      {draftFilters.length ? <div className="condition-list">{draftFilters.map((filter, index) =>
        <span className="condition-chip" key={`${filter.column}-${index}`}>
          {filter.column} {copy.filterOperators[filter.operator]} {scalarLabel(filter.value)}
          <button type="button" aria-label={copy.removeFilterCondition(filter.column)} onClick={() => removeCondition(index)}>×</button>
        </span>)}</div> : <span className="filter-empty-state">{copy.filterEmptyState}</span>}
    </section>
    <div className="filter-actions" role="group" aria-label={copy.filterActions}>
      <button type="button" aria-label={copy.clearFilters} onClick={clearFilters}>{copy.clearFilters}</button>
      <label>{copy.previewRows}<input aria-label={copy.previewRows} type="number" min="1" max="100000" value={previewLimit} onChange={(event) => { setPreviewLimit(Number(event.target.value)); setError('') }} /></label>
      <button type="button" className="primary-button" aria-label={copy.runFilters} onClick={run}>{copy.runFilters}</button>
    </div>
  </section>
}
