import MonacoEditor, { type OnMount } from '@monaco-editor/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { editor, languages, Position } from 'monaco-editor'
import type { AppError, ColumnSchema } from '../../domain/types'
import { getSqlCompletions } from './sqlCompletion'

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
  const text = `${error.message}${error.detail ? ` ${error.detail}` : ''}`
  const match = text.match(/\bline\s+(\d+)\s*[,;:]?\s*(?:column|col)\s+(\d+)/i) ??
    text.match(/\bline\s+(\d+)\s*:\s*(\d+)/i) ?? text.match(/\b(\d+)\s*:\s*(\d+)\b/)
  const lineNumber = Math.max(1, Number(match?.[1] ?? 1) || 1)
  const column = Math.max(1, Number(match?.[2] ?? 1) || 1)
  const message = error.message.replace(/[\r\n\t\0-\x1f\x7f]+/g, ' ').trim().slice(0, 1000) || 'SQL query failed'
  return { lineNumber, column, message }
}

export function SqlEditor({ tabId, fileId, value, columns, height, error, onChange, onRun, onHeightChange }: Props) {
  const uri = useMemo(() => `parquet-sql://${encodeURIComponent(fileId)}/${encodeURIComponent(tabId)}`, [fileId, tabId])
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null)
  const disposablesRef = useRef<Array<{ dispose(): void }>>([])
  const columnsRef = useRef(columns); columnsRef.current = columns
  const valueRef = useRef(value); valueRef.current = value
  const onRunRef = useRef(onRun); onRunRef.current = onRun
  const [mounted, setMounted] = useState(0)
  const [previewLimit, setPreviewLimit] = useState(10_000)
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
        return { suggestions: getSqlCompletions(valueRef.current, offset, columnsRef.current).map((item) => ({
          label: item.label, kind: kinds[item.kind], insertText: item.insertText, detail: item.detail,
          sortText: item.sortText, range,
          ...(item.insertTextRules ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
        })) }
      },
    })
    const hover = monaco.languages.registerHoverProvider('sql', {
      provideHover(model: editor.ITextModel, position: Position) {
        if (model.uri.toString() !== uri) return null
        const word = model.getWordAtPosition(position)?.word
        const column = columnsRef.current.find((item) => item.name === word)
        return column ? { contents: [{ value: `**${column.name}** — \`${column.logicalType}\` · ${column.nullable ? 'nullable' : 'not null'}` }] } : null
      },
    })
    disposablesRef.current = [completion, hover]
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run)
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, format)
    setMounted((count) => count + 1)
  }

  useEffect(() => () => {
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

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY; const startHeight = clampHeight(height)
    const move = (moveEvent: PointerEvent) => onHeightChange(clampHeight(startHeight + moveEvent.clientY - startY))
    const stop = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', stop) }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', stop, { once: true })
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
    <div className="sql-resize-handle" role="separator" aria-label="Resize SQL editor" aria-orientation="horizontal"
      aria-valuemin={MIN_HEIGHT} aria-valuemax={MAX_HEIGHT} aria-valuenow={clampHeight(height)} tabIndex={0}
      onPointerDown={startResize} onKeyDown={resizeKey} />
  </section>
}
