import MonacoEditor, { type OnMount } from '@monaco-editor/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { editor, languages, Position } from 'monaco-editor'
import '../../lib/monaco'
import { labelsFor } from '../../app/labels'
import type { AppError, AppLanguage, AppTheme, ColumnSchema } from '../../domain/types'
import { getSqlCompletions } from './sqlCompletion'
import { formatSql } from './sqlFormatting'
import { dollarDelimiterAt } from './sqlLexing'

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
  initialPreviewLimit?: number
  language?: AppLanguage
  theme?: AppTheme
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

const mutatingSqlKeywords = new Set([
  'ALTER', 'ATTACH', 'COPY', 'CREATE', 'DELETE', 'DETACH', 'DROP', 'GRANT', 'INSERT',
  'MERGE', 'PRAGMA', 'REPLACE', 'REVOKE', 'TRUNCATE', 'UPDATE', 'VACUUM',
])

export const containsMutatingSql = (sql: string) => {
  for (let index = 0; index < sql.length;) {
    if (/\s/.test(sql[index])) { index += 1; continue }
    if (sql.startsWith('--', index)) { const end = sql.indexOf('\n', index + 2); index = end < 0 ? sql.length : end + 1; continue }
    if (sql.startsWith('/*', index)) { const end = sql.indexOf('*/', index + 2); index = end < 0 ? sql.length : end + 2; continue }
    if (sql[index] === "'" || sql[index] === '"') {
      const quote = sql[index]; index += 1
      while (index < sql.length) {
        if (sql[index] === quote && sql[index + 1] === quote) { index += 2; continue }
        if (sql[index] === quote) { index += 1; break }
        index += 1
      }
      continue
    }
    const delimiter = dollarDelimiterAt(sql, index)
    if (delimiter) { const end = sql.indexOf(delimiter, index + delimiter.length); index = end < 0 ? sql.length : end + delimiter.length; continue }
    if (/[A-Za-z_]/.test(sql[index])) {
      const start = index
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) index += 1
      if (mutatingSqlKeywords.has(sql.slice(start, index).toUpperCase())) return true
      continue
    }
    index += 1
  }
  return false
}

export function SqlEditor({ tabId, fileId, value, columns, height, error, onChange, onRun, onHeightChange, initialPreviewLimit = 10_000, language = 'en', theme = 'system' }: Props) {
  const uri = useMemo(() => `parquet-sql://${encodeURIComponent(fileId)}/${encodeURIComponent(tabId)}`, [fileId, tabId])
  const copy = labelsFor(language)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null)
  const disposablesRef = useRef<Array<{ dispose(): void }>>([])
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const columnsRef = useRef(columns); columnsRef.current = columns
  const valueRef = useRef(value); valueRef.current = value
  const onRunRef = useRef(onRun); onRunRef.current = onRun
  const [mounted, setMounted] = useState(0)
  const [previewLimit, setPreviewLimit] = useState(initialPreviewLimit)
  const [copyFeedback, setCopyFeedback] = useState<'success' | 'error' | null>(null)
  const [readOnlyOpen, setReadOnlyOpen] = useState(false)
  const systemDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  const quotedFirstColumn = columns[0] ? `"${columns[0].name.replaceAll('"', '""')}"` : null
  const examples = [
    { id: 'preview', label: copy.sqlExamplePreview, sql: 'SELECT *\nFROM data\nLIMIT 100' },
    { id: 'count', label: copy.sqlExampleCount, sql: 'SELECT COUNT(*) AS row_count\nFROM data' },
    ...(quotedFirstColumn ? [{ id: 'non-null', label: copy.sqlExampleNonNull, sql: `SELECT *\nFROM data\nWHERE ${quotedFirstColumn} IS NOT NULL\nLIMIT 100` }] : []),
  ]

  useEffect(() => setPreviewLimit(initialPreviewLimit), [initialPreviewLimit])

  const clearMarkers = () => {
    const model = editorRef.current?.getModel()
    if (model && monacoRef.current) monacoRef.current.editor.setModelMarkers(model, MARKER_OWNER, [])
  }

  const run = () => {
    clearMarkers()
    if (containsMutatingSql(valueRef.current)) { setReadOnlyOpen(true); return }
    onRunRef.current(previewLimit)
  }
  const format = () => { void editorRef.current?.getAction('editor.action.formatDocument')?.run() }
  const loadExample = (id: string) => {
    const example = examples.find((item) => item.id === id)
    if (!example) return
    clearMarkers(); onChange(example.sql); editorRef.current?.focus()
  }

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

  return <>
    <section className="sql-editor-shell" style={{ height: clampHeight(height) }}>
    <div className="sql-toolbar">
      <strong>SQL</strong><span>{copy.table}: <code>data</code></span>
      <select className="sql-example-select settings-style-select" aria-label={copy.sqlExamples} value="" onChange={(event) => loadExample(event.target.value)}>
        <option value="">{copy.sqlExamples}</option>
        {examples.map((example) => <option key={example.id} value={example.id}>{example.label}</option>)}
      </select>
      <label>{copy.previewRows} <input aria-label={copy.sqlPreviewRows} type="number" min={1} max={100_000} value={previewLimit}
        onChange={(event) => setPreviewLimit(Number(event.target.value))} /></label>
      <button type="button" onClick={format}>{copy.formatSql}</button>
      <button type="button" className="primary-button" onClick={run}>{copy.runSql}</button>
    </div>
    <div className="sql-editor-body">
      <MonacoEditor path={uri} keepCurrentModel language="sql" theme={dark ? 'vs-dark' : 'light'} value={value}
        onChange={(next) => { clearMarkers(); onChange(next ?? '') }}
        onMount={onMount} options={{ ariaLabel: copy.sqlEditor, minimap: { enabled: false }, wordWrap: 'on', automaticLayout: true, scrollBeyondLastLine: false }} />
    </div>
    {error?.detail && <details className="sql-error-details">
      <summary>{copy.errorDetails}</summary>
      <pre aria-label={copy.sqlErrorDetails} tabIndex={0}>{error.detail}</pre>
      <button type="button" onClick={() => void copyDetails()}>{copy.copyDetails}</button>
      {copyFeedback === 'success' && <span role="status">{copy.copiedDetails}</span>}
      {copyFeedback === 'error' && <span role="alert">{copy.couldNotCopyDetails}</span>}
    </details>}
    <div className="sql-resize-handle" role="separator" aria-label={copy.resizeSqlEditor} aria-orientation="horizontal"
      aria-valuemin={MIN_HEIGHT} aria-valuemax={MAX_HEIGHT} aria-valuenow={clampHeight(height)} tabIndex={0}
      onPointerDown={startResize} onKeyDown={resizeKey} />
    </section>
    {readOnlyOpen && <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReadOnlyOpen(false) }}>
      <section className="read-only-dialog" role="dialog" aria-modal="true" aria-label={copy.readOnlySqlTitle}>
        <header><strong>{copy.readOnlySqlTitle}</strong><button type="button" aria-label={copy.closeReadOnlySql} onClick={() => setReadOnlyOpen(false)}>×</button></header>
        <p>{copy.readOnlySqlMessage}</p>
        <footer><button type="button" onClick={() => setReadOnlyOpen(false)}>{copy.close}</button></footer>
      </section>
    </div>}
  </>
}
