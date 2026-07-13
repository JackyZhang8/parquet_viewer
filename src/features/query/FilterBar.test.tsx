import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { FilterBar } from './FilterBar'

const columns = [
  {name:'id',logicalType:'INT64',nullable:false}, {name:'active',logicalType:'BOOLEAN',nullable:true},
  {name:'amount',logicalType:'DECIMAL(5,2)',nullable:true}, {name:'name',logicalType:'VARCHAR',nullable:true},
  {name:'created',logicalType:'DATE',nullable:true},
]

it('adds typed and null conditions, removes, clears, and runs exact request', async () => {
  const onFiltersChange = vi.fn(); const onRun = vi.fn()
  const { rerender } = render(<FilterBar columns={columns} filters={[]} sorts={[]} onFiltersChange={onFiltersChange} onSortsChange={vi.fn()} onRun={onRun} />)
  await userEvent.selectOptions(screen.getByLabelText('Filter column'), 'active')
  expect(screen.getByLabelText('Filter value').tagName).toBe('SELECT')
  await userEvent.selectOptions(screen.getByLabelText('Filter value'), 'true')
  await userEvent.click(screen.getByRole('button',{name:'Add condition'}))
  expect(onFiltersChange).toHaveBeenLastCalledWith([{column:'active',operator:'eq',value:{type:'boolean',value:true}}])
  const filters = onFiltersChange.mock.calls.at(-1)![0]
  rerender(<FilterBar columns={columns} filters={filters} sorts={[]} onFiltersChange={onFiltersChange} onSortsChange={vi.fn()} onRun={onRun} />)
  await userEvent.selectOptions(screen.getByLabelText('Filter column'), 'name')
  await userEvent.selectOptions(screen.getByLabelText('Filter operator'), 'isNull')
  expect(screen.queryByLabelText('Filter value')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button',{name:'Add condition'}))
  const withNull = onFiltersChange.mock.calls.at(-1)![0]
  rerender(<FilterBar columns={columns} filters={withNull} sorts={[]} onFiltersChange={onFiltersChange} onSortsChange={vi.fn()} onRun={onRun} />)
  await userEvent.click(screen.getByRole('button',{name:'Run filters'}))
  expect(onRun).toHaveBeenCalledWith({selectedColumns:[],filters:[{column:'active',operator:'eq',value:{type:'boolean',value:true}},{column:'name',operator:'isNull'}],sorts:[],previewLimit:10000})
  await userEvent.click(screen.getByRole('button',{name:/remove active/i}))
  await userEvent.click(screen.getByRole('button',{name:'Clear filters'}))
  expect(onFiltersChange).toHaveBeenLastCalledWith([])
})

it('initializes null-only columns safely and reacts to column replacement', () => {
  const props = { filters:[], sorts:[], onFiltersChange:vi.fn(), onSortsChange:vi.fn(), onRun:vi.fn() }
  const { rerender } = render(<FilterBar columns={[{name:'blob',logicalType:'BINARY',nullable:true}]} {...props} />)
  expect(screen.getByLabelText('Filter operator')).toHaveValue('isNull')
  expect(screen.queryByLabelText('Filter value')).not.toBeInTheDocument()
  rerender(<FilterBar columns={[{name:'flag',logicalType:'BOOLEAN',nullable:true}]} {...props} />)
  expect(screen.getByLabelText('Filter column')).toHaveValue('flag')
  expect(screen.getByLabelText('Filter operator')).toHaveValue('eq')
  expect(screen.getByLabelText('Filter value')).toBeInTheDocument()
})

it('shows scalar values and restores focus after removal and clear', async () => {
  const filters = [{column:'id',operator:'eq' as const,value:{type:'integer' as const,value:'42'}},{column:'name',operator:'isNull' as const,value:{type:'null' as const}}]
  const onFiltersChange = vi.fn()
  render(<FilterBar columns={columns} filters={filters} sorts={[]} onFiltersChange={onFiltersChange} onSortsChange={vi.fn()} onRun={vi.fn()} />)
  expect(screen.getByText(/id equals 42/i)).toBeInTheDocument()
  expect(screen.getByText(/name is null NULL/i)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button',{name:/remove id/i}))
  expect(screen.getByRole('button',{name:'Add condition'})).toHaveFocus()
  await userEvent.click(screen.getByRole('button',{name:'Clear filters'}))
  expect(screen.getByRole('button',{name:'Add condition'})).toHaveFocus()
})

it('restores add-sort focus after removing a sort', async () => {
  render(<FilterBar columns={columns} filters={[]} sorts={[{column:'id',direction:'asc'}]} onFiltersChange={vi.fn()} onSortsChange={vi.fn()} onRun={vi.fn()} />)
  await userEvent.click(screen.getByRole('button',{name:/remove id sort/i}))
  expect(screen.getByRole('button',{name:'Add sort'})).toHaveFocus()
})

it('shows inline integer and decimal validation and changes operator options', async () => {
  render(<FilterBar columns={columns} filters={[]} sorts={[]} onFiltersChange={vi.fn()} onSortsChange={vi.fn()} onRun={vi.fn()} />)
  await userEvent.selectOptions(screen.getByLabelText('Filter column'), 'amount')
  expect(within(screen.getByLabelText('Filter operator')).queryByRole('option',{name:/contains/i})).not.toBeInTheDocument()
  await userEvent.type(screen.getByLabelText('Filter value'), '1.234')
  await userEvent.click(screen.getByRole('button',{name:'Add condition'}))
  expect(screen.getByRole('alert')).toHaveTextContent(/scale/i)
  await userEvent.selectOptions(screen.getByLabelText('Filter column'), 'id')
  await userEvent.clear(screen.getByLabelText('Filter value')); await userEvent.type(screen.getByLabelText('Filter value'), '9223372036854775808')
  await userEvent.click(screen.getByRole('button',{name:'Add condition'}))
  expect(screen.getByRole('alert')).toHaveTextContent(/signed/i)
})

it('edits unique max-three sorts and reorders priority', async () => {
  const onSortsChange = vi.fn()
  const { rerender } = render(<FilterBar columns={columns} filters={[]} sorts={[]} onFiltersChange={vi.fn()} onSortsChange={onSortsChange} onRun={vi.fn()} />)
  for (const name of ['id','active','amount']) { await userEvent.selectOptions(screen.getByLabelText('Sort column'), name); await userEvent.click(screen.getByRole('button',{name:'Add sort'})) }
  let sorts = onSortsChange.mock.calls.at(-1)![0]
  rerender(<FilterBar columns={columns} filters={[]} sorts={sorts} onFiltersChange={vi.fn()} onSortsChange={onSortsChange} onRun={vi.fn()} />)
  expect(screen.getByRole('button',{name:'Add sort'})).toBeDisabled()
  await userEvent.click(screen.getByRole('button',{name:/move amount up/i}))
  expect(onSortsChange).toHaveBeenLastCalledWith([{column:'id',direction:'asc'},{column:'amount',direction:'asc'},{column:'active',direction:'asc'}])
  expect(screen.getByLabelText('Sort column').querySelector('option[value="id"]')).toBeDisabled()
})
