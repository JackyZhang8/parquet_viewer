import { render, screen } from '@testing-library/react'
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

it('copies a field and catches clipboard failure', async () => {
  const onError = vi.fn()
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
  render(<SchemaPanel metadata={metadata} width={260} onWidthChange={vi.fn()} onError={onError} />)
  await userEvent.click(screen.getByRole('button', {name:/copy event_id/i}))
  expect(onError).toHaveBeenCalled()
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
  expect(screen.getByRole('button', {name:/expand schema/i})).toBeInTheDocument()
})
