import { render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { SchemaPanel } from './SchemaPanel'

const metadata = { fileId:'f', path:'/data/events.parquet', name:'events.parquet', sizeBytes:'2048', rowCount:'9007199254740993', rowGroupCount:3, columns:[
  {name:'event_id',logicalType:'UINT64',nullable:false}, {name:'created_at',logicalType:'TIMESTAMP_MICROS',nullable:true},
] }

it('shows file counters and searches schema fields', async () => {
  render(<SchemaPanel metadata={metadata} width={260} onWidthChange={vi.fn()} onError={vi.fn()} />)
  expect(screen.getByTitle('/data/events.parquet')).toBeInTheDocument()
  expect(screen.getByText('9,007,199,254,740,993 rows')).toBeInTheDocument()
  expect(screen.getByText('2 columns')).toBeInTheDocument()
  expect(screen.getByText('3 row groups')).toBeInTheDocument()
  await userEvent.type(screen.getByRole('searchbox', {name:/search fields/i}), 'created')
  expect(screen.queryByText('event_id')).not.toBeInTheDocument()
  expect(screen.getByText('created_at')).toBeInTheDocument()
})

it('labels binary and nested fields distinctly from unsupported fields', () => {
  render(<SchemaPanel metadata={{...metadata,columns:[
    {name:'payload',logicalType:'BINARY',nullable:true},
    {name:'items',logicalType:'LIST',nullable:true},
    {name:'mystery',logicalType:'MYSTERY',nullable:true},
  ]}} width={260} onWidthChange={vi.fn()} onError={vi.fn()} />)
  expect(screen.getByText(/BINARY · nullable · binary/)).toBeInTheDocument()
  expect(screen.getByText(/LIST · nullable · nested/)).toBeInTheDocument()
  expect(screen.getByText(/MYSTERY · nullable · unsupported/)).toBeInTheDocument()
})

it('copies a field and catches clipboard failure', async () => {
  const onError = vi.fn()
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
  render(<SchemaPanel metadata={metadata} width={260} onWidthChange={vi.fn()} onError={onError} />)
  await userEvent.click(screen.getByRole('button', {name:/copy field event_id, UINT64, required/i}))
  expect(onError).toHaveBeenCalled()
})

it('announces successful copy and exposes field details in the accessible name', async () => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  render(<SchemaPanel metadata={metadata} width={260} onWidthChange={vi.fn()} onError={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', {name:/copy field created_at, TIMESTAMP_MICROS, nullable/i}))
  expect(screen.getByRole('status')).toHaveTextContent(/copied created_at/i)
})

it('windows 5000 fields while search still reaches the full schema', async () => {
  const columns = Array.from({length:5000},(_,index)=>({name:`field_${index}`,logicalType:'INT64',nullable:false}))
  const { container } = render(<SchemaPanel metadata={{...metadata,columns}} width={260} onWidthChange={vi.fn()} onError={vi.fn()} />)
  expect(container.querySelectorAll('.schema-field').length).toBeLessThan(30)
  fireEvent.scroll(screen.getByRole('list',{name:/schema fields/i}), {target:{scrollTop:4800}})
  expect(container.querySelectorAll('.schema-field').length).toBeLessThan(30)
  await userEvent.type(screen.getByRole('searchbox',{name:/search fields/i}), 'field_4999')
  expect(screen.getByText('field_4999')).toBeInTheDocument()
})

it('has accessible loading, unavailable, error, empty, and collapse states', async () => {
  const { rerender } = render(<SchemaPanel state="loading" width={260} onWidthChange={vi.fn()} onError={vi.fn()} />)
  expect(screen.getByRole('status')).toHaveTextContent(/loading schema/i)
  rerender(<SchemaPanel state="unavailable" width={260} onWidthChange={vi.fn()} onError={vi.fn()} />)
  expect(screen.getByText(/unavailable/i)).toBeInTheDocument()
  rerender(<SchemaPanel state="error" width={260} onWidthChange={vi.fn()} onError={vi.fn()} />)
  expect(screen.getByRole('alert')).toHaveTextContent(/could not/i)
  rerender(<SchemaPanel metadata={{...metadata,columns:[]}} width={260} onWidthChange={vi.fn()} onError={vi.fn()} />)
  expect(screen.getByText(/no columns/i)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', {name:/collapse schema/i}))
  expect(screen.getByRole('button', {name:/expand schema/i})).toHaveFocus()
})
