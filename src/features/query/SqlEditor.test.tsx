import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppError, ColumnSchema } from '../../domain/types'

const mocks = vi.hoisted(() => ({
  completion: vi.fn(), hover: vi.fn(), setMarkers: vi.fn(), completionDispose: vi.fn(), hoverDispose: vi.fn(),
  formatting: vi.fn(), formattingDispose: vi.fn(), addCommand: vi.fn(), trigger: vi.fn(), modelDispose: vi.fn(), commands: [] as Array<() => void>,
}))

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')
  const model = {
    uri: { toString: () => 'parquet-sql://file/tab-a' }, dispose: mocks.modelDispose,
    getOffsetAt: ({ column }: { column: number }) => column - 1,
    getWordAtPosition: () => ({ word: 'simple' }),
    getLineContent: () => 'SELECT "order value", "a""b", simple FROM data',
    getValue: () => 'select * from data where id=1',
    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 30 }),
  }
  const editor = {
    getModel: () => model,
    addCommand: mocks.addCommand.mockImplementation((_key: number, callback: () => void) => { mocks.commands.push(callback) }),
    getAction: () => ({ run: mocks.trigger }), focus: vi.fn(),
  }
  const monaco = {
    languages: {
      CompletionItemKind: { Field: 1, Module: 2, Keyword: 3, Function: 4, EnumMember: 5, Value: 6, Text: 7, Event: 8, File: 9, Struct: 10 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 }, HoverProvider: {},
      registerCompletionItemProvider: mocks.completion.mockReturnValue({ dispose: mocks.completionDispose }),
      registerHoverProvider: mocks.hover.mockReturnValue({ dispose: mocks.hoverDispose }),
      registerDocumentFormattingEditProvider: mocks.formatting.mockReturnValue({ dispose: mocks.formattingDispose }),
    },
    editor: { setModelMarkers: mocks.setMarkers },
    KeyMod: { CtrlCmd: 1 }, KeyCode: { Enter: 2, KeyF: 4 },
    Range: class { constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {} },
    MarkerSeverity: { Error: 8 },
  }
  return { default: (props: Record<string, unknown>) => {
    React.useEffect(() => { (props.onMount as Function)(editor, monaco) }, [])
    return React.createElement('textarea', {
      'aria-label': (props.options as { ariaLabel: string }).ariaLabel,
      value: props.value as string,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => (props.onChange as Function)(event.target.value),
    })
  } }
})

import { columnNameAtPosition, parseSqlErrorMarker, SqlEditor } from './SqlEditor'

const columns: ColumnSchema[] = [{ name: 'order value', logicalType: 'VARCHAR', nullable: true }]
const base = { tabId: 'tab-a', fileId: 'file', value: 'SELECT ', columns, height: 180, onChange: vi.fn(), onRun: vi.fn(), onHeightChange: vi.fn() }

beforeEach(() => { vi.clearAllMocks(); mocks.commands.length = 0 })
afterEach(() => vi.restoreAllMocks())

it('registers URI-scoped completion and hover providers and disposes them with the model', () => {
  const view = render(<SqlEditor {...base} />)
  const completion = mocks.completion.mock.calls[0][1]
  expect(completion.provideCompletionItems({ uri: { toString: () => 'other' } }, { lineNumber: 1, column: 8 })).toEqual({ suggestions: [] })
  const suggestions = completion.provideCompletionItems({ uri: { toString: () => 'parquet-sql://file/tab-a' }, getOffsetAt: () => 7 }, { lineNumber: 1, column: 8 }).suggestions
  expect(suggestions[0]).toMatchObject({ label: 'order value', insertText: '"order value"', kind: 7 })
  const hover = mocks.hover.mock.calls[0][1].provideHover({ uri: { toString: () => 'parquet-sql://file/tab-a' }, getLineContent: () => 'SELECT "order value" FROM data', getWordAtPosition: () => null }, { lineNumber: 1, column: 15 })
  expect(hover.contents[0].value).toMatch(/VARCHAR.*nullable/i)
  view.unmount()
  expect(mocks.completionDispose).toHaveBeenCalledTimes(1)
  expect(mocks.hoverDispose).toHaveBeenCalledTimes(1)
  expect(mocks.formattingDispose).toHaveBeenCalledTimes(1)
  expect(mocks.modelDispose).toHaveBeenCalledTimes(1)
})

it('resolves simple and ANSI quoted identifiers under the cursor', () => {
  expect(columnNameAtPosition('SELECT simple FROM data', 10)).toBe('simple')
  expect(columnNameAtPosition('SELECT "order value" FROM data', 15)).toBe('order value')
  expect(columnNameAtPosition('SELECT "a""b" FROM data', 12)).toBe('a"b')
  expect(columnNameAtPosition("SELECT 'order value'", 15)).toBeNull()
  expect(columnNameAtPosition('SELECT simple -- later', 10)).toBe('simple')
})

it('registers a URI-scoped formatter that replaces the whole document', () => {
  const view = render(<SqlEditor {...base} />)
  const provider = mocks.formatting.mock.calls[0][1]
  expect(provider.provideDocumentFormattingEdits({ uri: { toString: () => 'other' } })).toEqual([])
  expect(provider.provideDocumentFormattingEdits({
    uri: { toString: () => 'parquet-sql://file/tab-a' }, getValue: () => 'select * from data where id=1',
    getFullModelRange: () => ({ marker: 'full' }),
  })).toEqual([{ range: { marker: 'full' }, text: 'SELECT *\nFROM data\nWHERE id = 1' }])
  view.unmount()
  expect(mocks.formattingDispose).toHaveBeenCalledTimes(1)
})

it('updates the controlled draft and runs/formats by toolbar and shortcut', async () => {
  const onChange = vi.fn(); const onRun = vi.fn()
  render(<SqlEditor {...base} onChange={onChange} onRun={onRun} />)
  await userEvent.type(screen.getByRole('textbox', { name: 'SQL editor' }), 'x')
  expect(onChange).toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Run SQL' }))
  mocks.commands[0]()
  expect(onRun).toHaveBeenCalledTimes(2)
  await userEvent.click(screen.getByRole('button', { name: 'Format SQL' }))
  expect(mocks.trigger).toHaveBeenCalled()
})

it('parses safe locations, falls back, sets error markers, and clears them on edit', () => {
  expect(parseSqlErrorMarker({ code: 'SQL_ERROR', message: 'The query has invalid SQL syntax', detail: 'Parser Error: Expected expression\nline 3 column 9' })).toMatchObject({ lineNumber: 3, column: 9 })
  expect(parseSqlErrorMarker({ code: 'SQL_ERROR', message: 'bad', detail: null })).toMatchObject({ lineNumber: 1, column: 1 })
  const error: AppError = { code: 'SQL_ERROR', message: 'The query has invalid SQL syntax', detail: 'line 3 column 9' }
  const view = render(<SqlEditor {...base} error={error} />)
  expect(mocks.setMarkers).toHaveBeenLastCalledWith(expect.anything(), 'parquet-viewer-sql', [expect.objectContaining({ startLineNumber: 3, startColumn: 9, message: expect.not.stringContaining('\n') })])
  fireEvent.change(screen.getByRole('textbox', { name: 'SQL editor' }), { target: { value: 'changed' } })
  expect(mocks.setMarkers).toHaveBeenLastCalledWith(expect.anything(), 'parquet-viewer-sql', [])
  view.rerender(<SqlEditor {...base} error={undefined} />)
  expect(mocks.setMarkers).toHaveBeenLastCalledWith(expect.anything(), 'parquet-viewer-sql', [])
})

it('shows accessible SQL details and reports copy success and failure', async () => {
  const detail = 'Binder Error: Referenced column [identifier] not found\nline 2 column 8'
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  render(<SqlEditor {...base} error={{ code: 'SQL_ERROR', message: 'The query could not be prepared or executed', detail }} />)
  expect(screen.getByText('Error details')).toBeInTheDocument()
  expect(screen.getByLabelText('SQL error details')).toHaveTextContent('Binder Error')
  await userEvent.click(screen.getByRole('button', { name: 'Copy details' }))
  expect(writeText).toHaveBeenCalledWith(detail)
  expect(screen.getByRole('status')).toHaveTextContent('Copied details')
  writeText.mockRejectedValueOnce(new Error('denied'))
  await userEvent.click(screen.getByRole('button', { name: 'Copy details' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Could not copy details')
})

it('supports keyboard editor resizing within the allowed range', () => {
  const onHeightChange = vi.fn()
  render(<SqlEditor {...base} onHeightChange={onHeightChange} />)
  const handle = screen.getByRole('separator', { name: 'Resize SQL editor' })
  fireEvent.keyDown(handle, { key: 'ArrowDown' })
  fireEvent.keyDown(handle, { key: 'Home' })
  fireEvent.keyDown(handle, { key: 'End' })
  expect(onHeightChange.mock.calls.map(([height]) => height)).toEqual([190, 120, 600])
})

it('removes active resize listeners when unmounted mid-drag', () => {
  const onHeightChange = vi.fn()
  const view = render(<SqlEditor {...base} onHeightChange={onHeightChange} />)
  fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize SQL editor' }), { clientY: 100 })
  view.unmount()
  fireEvent.pointerMove(document, { clientY: 250 })
  fireEvent.pointerUp(document)
  expect(onHeightChange).not.toHaveBeenCalled()
})

it('maps schema type families to distinct Monaco completion kinds', () => {
  const typed: ColumnSchema[] = [
    { name: 'flag', logicalType: 'BOOLEAN', nullable: false },
    { name: 'amount', logicalType: 'DOUBLE', nullable: false },
    { name: 'name', logicalType: 'VARCHAR', nullable: false },
  ]
  render(<SqlEditor {...base} columns={typed} />)
  const suggestions = mocks.completion.mock.calls[0][1].provideCompletionItems(
    { uri: { toString: () => 'parquet-sql://file/tab-a' }, getOffsetAt: () => 7 }, { lineNumber: 1, column: 8 },
  ).suggestions
  expect(['flag', 'amount', 'name'].map((label) => suggestions.find((item: { label: string }) => item.label === label).kind)).toEqual([5, 6, 7])
})
