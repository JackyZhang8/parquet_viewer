import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { AppliedFilterChips, FilterBar } from './FilterBar'

const columns = [
  { name: 'id', logicalType: 'INT64', nullable: false }, { name: 'active', logicalType: 'BOOLEAN', nullable: true },
  { name: 'amount', logicalType: 'DECIMAL(5,2)', nullable: true }, { name: 'name', logicalType: 'VARCHAR', nullable: true },
  { name: 'created', logicalType: 'DATE', nullable: true },
]

it('keeps draft conditions local until the user applies them', async () => {
  const onFiltersChange = vi.fn(); const onRun = vi.fn()
  render(<FilterBar columns={columns} filters={[]} onFiltersChange={onFiltersChange} onRun={onRun} />)

  await userEvent.selectOptions(screen.getByLabelText('Filter column'), 'active')
  expect(screen.getByLabelText('Filter value').tagName).toBe('SELECT')
  await userEvent.selectOptions(screen.getByLabelText('Filter value'), 'true')
  await userEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  expect(onFiltersChange).not.toHaveBeenCalled()

  await userEvent.selectOptions(screen.getByLabelText('Filter column'), 'name')
  await userEvent.selectOptions(screen.getByLabelText('Filter operator'), 'isNull')
  expect(screen.queryByLabelText('Filter value')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  await userEvent.click(screen.getByRole('button', { name: 'Run filters' }))

  const filters = [
    { column: 'active', operator: 'eq' as const, value: { type: 'boolean' as const, value: true } },
    { column: 'name', operator: 'isNull' as const, value: { type: 'null' as const } },
  ]
  expect(onFiltersChange).toHaveBeenCalledWith(filters)
  expect(onRun).toHaveBeenCalledWith({
    selectedColumns: [], filters: [
      { column: 'active', operator: 'eq', value: { type: 'boolean', value: true } },
      { column: 'name', operator: 'isNull' },
    ], sorts: [], previewLimit: 10_000,
  })
})

it('organizes the filter builder, draft conditions, and actions into separate sections', () => {
  render(<FilterBar columns={columns} filters={[]} onFiltersChange={vi.fn()} onRun={vi.fn()} />)

  const builder = screen.getByRole('group', { name: 'Build a condition' })
  const conditions = screen.getByRole('region', { name: 'Conditions' })
  const actions = screen.getByRole('group', { name: 'Filter actions' })

  expect(builder).toContainElement(screen.getByLabelText('Filter column'))
  expect(builder).toContainElement(screen.getByLabelText('Filter operator'))
  expect(builder).toContainElement(screen.getByLabelText('Filter value'))
  expect(conditions).toHaveTextContent('No conditions yet. Add one above.')
  expect(builder.compareDocumentPosition(conditions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(conditions.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('initializes null-only columns safely and reacts to column replacement', () => {
  const props = { filters: [], onFiltersChange: vi.fn(), onRun: vi.fn() }
  const { rerender } = render(<FilterBar columns={[{ name: 'blob', logicalType: 'BINARY', nullable: true }]} {...props} />)
  expect(screen.getByLabelText('Filter operator')).toHaveValue('isNull')
  expect(screen.queryByLabelText('Filter value')).not.toBeInTheDocument()
  rerender(<FilterBar columns={[{ name: 'flag', logicalType: 'BOOLEAN', nullable: true }]} {...props} />)
  expect(screen.getByLabelText('Filter column')).toHaveValue('flag')
  expect(screen.getByLabelText('Filter operator')).toHaveValue('eq')
  expect(screen.getByLabelText('Filter value')).toBeInTheDocument()
})

it('shows draft scalar values and restores focus after removal and clear', async () => {
  const filters = [
    { column: 'id', operator: 'eq' as const, value: { type: 'integer' as const, value: '42' } },
    { column: 'name', operator: 'isNull' as const, value: { type: 'null' as const } },
  ]
  render(<FilterBar columns={columns} filters={filters} onFiltersChange={vi.fn()} onRun={vi.fn()} />)
  expect(screen.getByText(/id equals 42/i)).toBeInTheDocument()
  expect(screen.getByText(/name is null NULL/i)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /remove id/i }))
  expect(screen.getByRole('button', { name: 'Add condition' })).toHaveFocus()
  await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(screen.getByRole('button', { name: 'Add condition' })).toHaveFocus()
})

it('shows inline integer and decimal validation and changes operator options', async () => {
  render(<FilterBar columns={columns} filters={[]} onFiltersChange={vi.fn()} onRun={vi.fn()} />)
  await userEvent.selectOptions(screen.getByLabelText('Filter column'), 'amount')
  expect(within(screen.getByLabelText('Filter operator')).queryByRole('option', { name: /contains/i })).not.toBeInTheDocument()
  await userEvent.type(screen.getByLabelText('Filter value'), '1.234')
  await userEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  expect(screen.getByRole('alert')).toHaveTextContent(/scale/i)
  await userEvent.selectOptions(screen.getByLabelText('Filter column'), 'id')
  await userEvent.clear(screen.getByLabelText('Filter value')); await userEvent.type(screen.getByLabelText('Filter value'), '9223372036854775808')
  await userEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  expect(screen.getByRole('alert')).toHaveTextContent(/signed/i)
})

it('caps the preview control and reports values above 100000', async () => {
  render(<FilterBar columns={columns} filters={[]} onFiltersChange={vi.fn()} onRun={vi.fn()} />)
  expect(screen.getByLabelText('Preview rows')).toHaveAttribute('max', '100000')
  await userEvent.clear(screen.getByLabelText('Preview rows')); await userEvent.type(screen.getByLabelText('Preview rows'), '100001')
  await userEvent.click(screen.getByRole('button', { name: 'Run filters' }))
  expect(screen.getByRole('alert')).toHaveTextContent(/between 1 and 100000/i)
})

it('uses local Chinese labels for the filter editor and applied chips', () => {
  render(<FilterBar language="zh" columns={columns} filters={[]} onFiltersChange={vi.fn()} onRun={vi.fn()} />)
  expect(screen.getByLabelText('筛选列')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '添加条件' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '应用筛选' })).toBeInTheDocument()

  render(<AppliedFilterChips language="zh" filters={[
    { column: 'id', operator: 'eq', value: { type: 'integer', value: '42' } },
  ]} onRemove={vi.fn()} onClear={vi.fn()} />)
  const applied = screen.getByRole('region', { name: '已应用筛选' })
  expect(applied).toHaveTextContent('id 等于 42')
  expect(within(applied).getByRole('button', { name: '清除筛选' })).toBeInTheDocument()
})

it('marks every filter dropdown for the settings-style select treatment', async () => {
  render(<FilterBar columns={columns} filters={[]} onFiltersChange={vi.fn()} onRun={vi.fn()} />)

  expect(screen.getByLabelText('Filter column')).toHaveClass('filter-select')
  expect(screen.getByLabelText('Filter operator')).toHaveClass('filter-select')
  await userEvent.selectOptions(screen.getByLabelText('Filter column'), 'active')
  expect(screen.getByLabelText('Filter value')).toHaveClass('filter-select')
})

it('reruns the remaining filters when a draft condition is removed', async () => {
  const onFiltersChange = vi.fn()
  const onRun = vi.fn()
  render(<FilterBar columns={columns} filters={[
    { column: 'id', operator: 'eq', value: { type: 'integer', value: '42' } },
    { column: 'name', operator: 'contains', value: { type: 'string', value: 'oak' } },
  ]} onFiltersChange={onFiltersChange} onRun={onRun} />)

  await userEvent.click(screen.getByRole('button', { name: 'Remove id condition' }))

  const remaining = [{ column: 'name', operator: 'contains' as const, value: { type: 'string' as const, value: 'oak' } }]
  expect(onFiltersChange).toHaveBeenCalledWith(remaining)
  expect(onRun).toHaveBeenCalledWith({ selectedColumns: [], filters: remaining, sorts: [], previewLimit: 10_000 })
})
