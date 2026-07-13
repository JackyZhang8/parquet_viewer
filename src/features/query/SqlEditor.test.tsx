import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppError, ColumnSchema } from '../../domain/types'

const mocks = vi.hoisted(() => ({
  completion: vi.fn(), hover: vi.fn(), setMarkers: vi.fn(), completionDispose: vi.fn(), hoverDispose: vi.fn(),
  addCommand: vi.fn(), trigger: vi.fn(), modelDispose: vi.fn(), commands: [] as Array<() => void>,
}))

vi.mock('@monaco-editor/react', async () => {
  const React = await import('react')
  const model = {
    uri: { toString: () => 'parquet-sql://file/tab-a' }, dispose: mocks.modelDispose,
    getOffsetAt: ({ column }: { column: number }) => column - 1,
    getWordAtPosition: () => ({ word: 'order value' }),
  }
  const editor = {
    getModel: () => model,
    addCommand: mocks.addCommand.mockImplementation((_key: number, callback: () => void) => { mocks.commands.push(callback) }),
    getAction: () => ({ run: mocks.trigger }), focus: vi.fn(),
  }
  const monaco = {
    languages: {
      CompletionItemKind: { Field: 1, Module: 2, Keyword: 3, Function: 4 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 }, HoverProvider: {},
      registerCompletionItemProvider: mocks.completion.mockReturnValue({ dispose: mocks.completionDispose }),
      registerHoverProvider: mocks.hover.mockReturnValue({ dispose: mocks.hoverDispose }),
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

import { parseSqlErrorMarker, SqlEditor } from './SqlEditor'

const columns: ColumnSchema[] = [{ name: 'order value', logicalType: 'VARCHAR', nullable: true }]
const base = { tabId: 'tab-a', fileId: 'file', value: 'SELECT ', columns, height: 180, onChange: vi.fn(), onRun: vi.fn(), onHeightChange: vi.fn() }

beforeEach(() => { vi.clearAllMocks(); mocks.commands.length = 0 })
afterEach(() => vi.restoreAllMocks())

it('registers URI-scoped completion and hover providers and disposes them with the model', () => {
  const view = render(<SqlEditor {...base} />)
  const completion = mocks.completion.mock.calls[0][1]
  expect(completion.provideCompletionItems({ uri: { toString: () => 'other' } }, { lineNumber: 1, column: 8 })).toEqual({ suggestions: [] })
  const suggestions = completion.provideCompletionItems({ uri: { toString: () => 'parquet-sql://file/tab-a' }, getOffsetAt: () => 7 }, { lineNumber: 1, column: 8 }).suggestions
  expect(suggestions[0]).toMatchObject({ label: 'order value', insertText: '"order value"', kind: 1 })
  const hover = mocks.hover.mock.calls[0][1].provideHover({ uri: { toString: () => 'parquet-sql://file/tab-a' }, getWordAtPosition: () => ({ word: 'order value' }) }, { lineNumber: 1, column: 1 })
  expect(hover.contents[0].value).toMatch(/VARCHAR.*nullable/i)
  view.unmount()
  expect(mocks.completionDispose).toHaveBeenCalledTimes(1)
  expect(mocks.hoverDispose).toHaveBeenCalledTimes(1)
  expect(mocks.modelDispose).toHaveBeenCalledTimes(1)
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
  expect(parseSqlErrorMarker({ code: 'SQL_ERROR', message: 'Parser error at line 3, column 9', detail: null })).toMatchObject({ lineNumber: 3, column: 9 })
  expect(parseSqlErrorMarker({ code: 'SQL_ERROR', message: 'bad', detail: null })).toMatchObject({ lineNumber: 1, column: 1 })
  const error: AppError = { code: 'SQL_ERROR', message: 'Parser error at line 3, column 9\nsecret', detail: null }
  const view = render(<SqlEditor {...base} error={error} />)
  expect(mocks.setMarkers).toHaveBeenLastCalledWith(expect.anything(), 'parquet-viewer-sql', [expect.objectContaining({ startLineNumber: 3, startColumn: 9, message: expect.not.stringContaining('\n') })])
  fireEvent.change(screen.getByRole('textbox', { name: 'SQL editor' }), { target: { value: 'changed' } })
  expect(mocks.setMarkers).toHaveBeenLastCalledWith(expect.anything(), 'parquet-viewer-sql', [])
  view.rerender(<SqlEditor {...base} error={undefined} />)
  expect(mocks.setMarkers).toHaveBeenLastCalledWith(expect.anything(), 'parquet-viewer-sql', [])
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
