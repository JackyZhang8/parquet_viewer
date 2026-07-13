import MonacoEditor, { type OnMount } from '@monaco-editor/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { editor, languages, Position } from 'monaco-editor'
import type { AppError, ColumnSchema } from '../../domain/types'
import { getSqlCompletions } from './sqlCompletion'
import { formatSql } from './sqlFormatting'

interface Props {
  tabId: string
  fileId: string
  value: string
  columns: ColumnSchema[]
  height: number
  error?: AppError
  onChange(value: string): void
  onRun(previewLimit: number): void
  onHeightChange(height: number): void
}

const MIN_HEIGHT = 120
const MAX_HEIGHT = 600
const MARKER_OWNER = 'parquet-viewer-sql'
const clampHeight = (height: number) => Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)))

export interface SqlErrorMarker {
  lineNumber: number
  column: number
  message: string
}

export const parseSqlErrorMarker = (error: AppError): SqlErrorMarker => {
  const match = error.detail?.match(/(?:^|\n)line ([1-9]\d*) column ([1-9]\d*)$/)
  const lineNumber = Math.max(1, Number(match?.[1] ?? 1) || 1)
  const column = Math.max(1, Number(match?.[2] ?? 1) || 1)
  const message = error.message.replace(/[\r\n\t\0-\x1f\x7f]+/g, ' ').trim().slice(0, 1000) || 'SQL query failed'
  return { lineNumber, column, message }
}

export const columnNameAtPosition = (line: string, column: number): string | null => {
  const cursor = Math.max(0, Math.min(line.length, column - 1))
  for (let index = 0; index < line.length;) {
    if (line[index] === '-' && line[index + 1] === '-') {
      if (cursor >= index) return null
      break
    }
    if (line[index] === '/' && line[index + 1] === '*') {
      const close = line.indexOf('*/', index + 2); const end = close < 0 ? line.length : close + 2
      if (cursor >= index && cursor < end) return null
      index = end; continue
    }
    if (line[index] === "'") {
      const start = index; index += 1
      while (index < line.length) {
        if (line[index] === "'" && line[index + 1] === "'") { index += 2; continue }
        if (line[index] === "'") { index += 1; break }
        index += 1
      }
      if (cursor >= start && cursor < index) return null
      continue
    }
    if (line[index] === '"') {
      const start = index; let name = ''; index += 1
      while (index < line.length) {
        if (line[index] === '"' && line[index + 1] === '"') { name += '"'; index += 2; continue }
        if (line[index] === '"') {
          if (cursor >= start && cursor <= index) return name
          index += 1; break
        }
        name += line[index]; index += 1
      }
      if (cursor >= start && cursor <= index) return name
      continue
    }
    index += 1
  }
  let start = cursor; let end = cursor
  while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1])) start -= 1
  while (end < line.length && /[A-Za-z0-9_]/.test(line[end])) end += 1
  const word = line.slice(start, end)
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word) ? word : null
}

export function SqlEditor({ tabId, fileId, value, columns, height, error, onChange, onRun, onHeightChange }: Props) {
  const uri = useMemo(() => `parquet-sql://${encodeURIComponent(fileId)}/${encodeURIComponent(tabId)}`, [fileId, tabId])
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null)
  const disposablesRef = useRef<Array<{ dispose(): void }>>([])
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const columnsRef = useRef(columns); columnsRef.current = columns
  const valueRef = useRef(value); valueRef.current = value
  const onRunRef = useRef(onRun); onRunRef.current = onRun
  const [mounted, setMounted] = useState(0)
  const [previewLimit, setPreviewLimit] = useState(10_000)
  const [copyFeedback, setCopyFeedback] = useState<'success' | 'error' | null>(null)
  const dark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches

  const clearMarkers = () => {
    const model = editorRef.current?.getModel()
    if (model && monacoRef.current) monacoRef.current.editor.setModelMarkers(model, MARKER_OWNER, [])
  }

  const run = () => { clearMarkers(); onRunRef.current(previewLimit) }
  const format = () => { void editorRef.current?.getAction('editor.action.formatDocument')?.run() }

  const onMount: OnMount = (instance, monaco) => {
    editorRef.current = instance; monacoRef.current = monaco
    const completion = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', '"'],
      provideCompletionItems(model: editor.ITextModel, position: Position) {
        if (model.uri.toString() !== uri) return { suggestions: [] }
        const offset = model.getOffsetAt(position)
        const word = model.getWordUntilPosition?.(position)
        const range = word
          ? new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
          : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
        const kinds: Record<string, languages.CompletionItemKind> = {
          field: monaco.languages.CompletionItemKind.Field, table: monaco.languages.CompletionItemKind.Module,
          keyword: monaco.languages.CompletionItemKind.Keyword, function: monaco.languages.CompletionItemKind.Function,
        }
        const fieldKinds: Record<string, languages.CompletionItemKind> = {
          boolean: monaco.languages.CompletionItemKind.EnumMember,
          numeric: monaco.languages.CompletionItemKind.Value,
          text: monaco.languages.CompletionItemKind.Text,
          temporal: monaco.languages.CompletionItemKind.Event,
          binary: monaco.languages.CompletionItemKind.File,
          nested: monaco.languages.CompletionItemKind.Struct,
          unknown: monaco.languages.CompletionItemKind.Field,
        }
        return { suggestions: getSqlCompletions(valueRef.current, offset, columnsRef.current).map((item) => ({
          label: item.label, kind: item.kind === 'field' ? fieldKinds[item.fieldType ?? 'unknown'] : kinds[item.kind], insertText: item.insertText, detail: item.detail,
          sortText: item.sortText, range,
          ...(item.insertTextRules ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
        })) }
      },
    })
    const hover = monaco.languages.registerHoverProvider('sql', {
      provideHover(model: editor.ITextModel, position: Position) {
        if (model.uri.toString() !== uri) return null
        const name = columnNameAtPosition(model.getLineContent(position.lineNumber), position.column) ?? model.getWordAtPosition(position)?.word
        const column = columnsRef.current.find((item) => item.name === name)
        return column ? { contents: [{ value: `**${column.name}** — \`${column.logicalType}\` · ${column.nullable ? 'nullable' : 'not null'}` }] } : null
      },
    })
    const formatting = monaco.languages.registerDocumentFormattingEditProvider('sql', {
      provideDocumentFormattingEdits(model: editor.ITextModel) {
        if (model.uri.toString() !== uri) return []
        return [{ range: model.getFullModelRange(), text: formatSql(model.getValue()) }]
      },
    })
    disposablesRef.current = [completion, hover, formatting]
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run)
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, format)
    setMounted((count) => count + 1)
  }

  useEffect(() => () => {
    resizeCleanupRef.current?.()
    disposablesRef.current.splice(0).forEach((disposable) => disposable.dispose())
    editorRef.current?.getModel()?.dispose()
    editorRef.current = null; monacoRef.current = null
  }, [uri])

  useEffect(() => {
    const model = editorRef.current?.getModel(); const monaco = monacoRef.current
    if (!model || !monaco) return
    if (!error) { monaco.editor.setModelMarkers(model, MARKER_OWNER, []); return }
    const marker = parseSqlErrorMarker(error)
    monaco.editor.setModelMarkers(model, MARKER_OWNER, [{
      severity: monaco.MarkerSeverity.Error, message: marker.message,
      startLineNumber: marker.lineNumber, startColumn: marker.column,
      endLineNumber: marker.lineNumber, endColumn: marker.column + 1,
    }])
  }, [error, mounted, tabId])
  useEffect(() => setCopyFeedback(null), [error?.detail, tabId])

  const copyDetails = async () => {
    if (!error?.detail) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(error.detail)
      setCopyFeedback('success')
    } catch { setCopyFeedback('error') }
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeCleanupRef.current?.()
    const startY = event.clientY; const startHeight = clampHeight(height)
    const move = (moveEvent: PointerEvent) => onHeightChange(clampHeight(startHeight + moveEvent.clientY - startY))
    let active = true
    const stop = () => {
      if (!active) return
      active = false
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', stop); document.removeEventListener('pointercancel', stop)
      if (resizeCleanupRef.current === stop) resizeCleanupRef.current = null
    }
    resizeCleanupRef.current = stop
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', stop); document.addEventListener('pointercancel', stop)
  }
  const resizeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | undefined
    if (event.key === 'ArrowUp') next = height - 10
    else if (event.key === 'ArrowDown') next = height + 10
    else if (event.key === 'Home') next = MIN_HEIGHT
    else if (event.key === 'End') next = MAX_HEIGHT
    if (next !== undefined) { event.preventDefault(); onHeightChange(clampHeight(next)) }
  }

  return <section className="sql-editor-shell" style={{ height: clampHeight(height) }}>
    <div className="sql-toolbar">
      <strong>SQL</strong><span>Table: <code>data</code></span>
      <label>Preview rows <input aria-label="SQL preview rows" type="number" min={1} max={10_000} value={previewLimit}
        onChange={(event) => setPreviewLimit(Number(event.target.value))} /></label>
      <button type="button" onClick={format}>Format SQL</button>
      <button type="button" className="primary-button" onClick={run}>Run SQL</button>
    </div>
    <div className="sql-editor-body">
      <MonacoEditor path={uri} keepCurrentModel language="sql" theme={dark ? 'vs-dark' : 'light'} value={value}
        onChange={(next) => { clearMarkers(); onChange(next ?? '') }}
        onMount={onMount} options={{ ariaLabel: 'SQL editor', minimap: { enabled: false }, wordWrap: 'on', automaticLayout: true, scrollBeyondLastLine: false }} />
    </div>
    {error?.detail && <details className="sql-error-details">
      <summary>Error details</summary>
      <pre aria-label="SQL error details" tabIndex={0}>{error.detail}</pre>
      <button type="button" onClick={() => void copyDetails()}>Copy details</button>
      {copyFeedback === 'success' && <span role="status">Copied details</span>}
      {copyFeedback === 'error' && <span role="alert">Could not copy details</span>}
    </details>}
    <div className="sql-resize-handle" role="separator" aria-label="Resize SQL editor" aria-orientation="horizontal"
      aria-valuemin={MIN_HEIGHT} aria-valuemax={MAX_HEIGHT} aria-valuenow={clampHeight(height)} tabIndex={0}
      onPointerDown={startResize} onKeyDown={resizeKey} />
  </section>
}
