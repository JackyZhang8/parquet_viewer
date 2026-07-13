import type { ColumnSchema } from '../../domain/types'
import { dollarDelimiterAt } from './sqlLexing'

export type SqlSuggestionKind = 'field' | 'table' | 'keyword' | 'function'
export type SqlFieldType = 'boolean' | 'numeric' | 'text' | 'temporal' | 'binary' | 'nested' | 'unknown'

export interface SqlSuggestion {
  label: string
  kind: SqlSuggestionKind
  insertText: string
  detail: string
  sortText: string
  insertTextRules?: 'snippet'
  fieldType?: SqlFieldType
}

export const sqlFieldType = (logicalType: string): SqlFieldType => {
  const type = logicalType.toLowerCase()
  if (/bool/.test(type)) return 'boolean'
  if (/(?:struct|list|map|array|union)/.test(type)) return 'nested'
  if (/(?:u?int|hugeint|decimal|numeric|float|double|real)/.test(type)) return 'numeric'
  if (/(?:date|time|timestamp|interval)/.test(type)) return 'temporal'
  if (/(?:blob|binary|byte)/.test(type)) return 'binary'
  if (/(?:char|text|string|utf8|json|uuid)/.test(type)) return 'text'
  return 'unknown'
}

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'INNER JOIN', 'ON', 'AS', 'DISTINCT',
  'AND', 'OR', 'NOT', 'NULL', 'IS NULL', 'IS NOT NULL', 'ASC', 'DESC', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
]
const RESERVED_WORDS = new Set([
  ...KEYWORDS.flatMap((keyword) => keyword.toLowerCase().split(' ')),
  ...'all alter analyze attach between by cast check create cross current delete describe drop exists explain false in insert intersect into lateral like natural primary qualify references returning table true union unique update using values with'.split(' '),
])

export const quoteSqlIdentifier = (name: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED_WORDS.has(name.toLowerCase())
    ? name : `"${name.replaceAll('"', '""')}"`

const FUNCTIONS: Array<[string, string]> = [
  ['count', 'count(${1:*})'], ['sum', 'sum(${1:column})'], ['avg', 'avg(${1:column})'],
  ['min', 'min(${1:column})'], ['max', 'max(${1:column})'], ['coalesce', 'coalesce(${1:value}, ${2:fallback})'],
  ['lower', 'lower(${1:text})'], ['upper', 'upper(${1:text})'], ['length', 'length(${1:text})'],
  ['round', 'round(${1:number}, ${2:digits})'], ['date_trunc', "date_trunc('${1:day}', ${2:column})"],
  ['strftime', "strftime(${1:column}, '${2:%Y-%m-%d}')"], ['extract', 'extract(${1:part} FROM ${2:column})'],
]

const inNonCode = (sql: string, offset: number): boolean => {
  let single = false; let line = false; let block = false; let dollar: string | null = null
  for (let index = 0; index < offset; index += 1) {
    const char = sql[index]; const next = sql[index + 1]
    if (dollar) {
      if (sql.startsWith(dollar, index)) { index += dollar.length - 1; dollar = null }
      continue
    }
    if (line) { if (char === '\n') line = false; continue }
    if (block) { if (char === '*' && next === '/') { block = false; index += 1 }; continue }
    if (single) {
      if (char === "'" && next === "'") { index += 1; continue }
      if (char === "'") single = false
      continue
    }
    const delimiter = dollarDelimiterAt(sql, index)
    if (delimiter) { dollar = delimiter; index += delimiter.length - 1 }
    else if (char === '-' && next === '-') { line = true; index += 1 }
    else if (char === '/' && next === '*') { block = true; index += 1 }
    else if (char === "'") single = true
  }
  return single || line || block || dollar !== null
}

const matchScore = (candidate: string, token: string): number | null => {
  const value = candidate.toLowerCase(); const query = token.toLowerCase()
  if (!query) return 0
  if (value === query) return -100
  if (value.startsWith(query)) return -80 + value.length
  let at = 0; let gaps = 0; let last = -1
  for (const char of query) {
    const found = value.indexOf(char, at)
    if (found < 0) return null
    if (last >= 0) gaps += found - last - 1
    last = found; at = found + 1
  }
  return gaps + value.length + 20
}

const context = (prefix: string): 'table' | 'field' | 'all' => {
  const normalized = prefix.replace(/\s+/g, ' ').toUpperCase()
  if (/(?:\bFROM|\bJOIN)\s+$/.test(normalized)) return 'table'
  if (/(?:\bSELECT|\bWHERE|\bGROUP\s+BY|\bHAVING|\bORDER\s+BY)\s+$/.test(normalized)) return 'field'
  return 'all'
}

export const getSqlCompletions = (sql: string, cursorOffset: number, columns: ColumnSchema[]): SqlSuggestion[] => {
  const offset = Math.max(0, Math.min(cursorOffset, sql.length))
  if (inNonCode(sql, offset)) return []
  const prefix = sql.slice(0, offset)
  const token = prefix.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? ''
  const mode = context(prefix.slice(0, prefix.length - token.length))
  const raw: Array<Omit<SqlSuggestion, 'sortText'> & { priority: number; order: number }> = []
  columns.forEach((column) => raw.push({
    label: column.name, kind: 'field', insertText: quoteSqlIdentifier(column.name),
    detail: `${column.logicalType}${column.nullable ? ' · nullable' : ' · not null'}`,
    fieldType: sqlFieldType(column.logicalType),
    priority: mode === 'field' ? 0 : mode === 'table' ? 3 : 1, order: raw.length,
  }))
  raw.push({ label: 'data', kind: 'table', insertText: 'data', detail: 'Current Parquet file', priority: mode === 'table' ? 0 : 1, order: raw.length })
  FUNCTIONS.forEach(([label, insertText]) => raw.push({ label, kind: 'function', insertText, insertTextRules: 'snippet', detail: 'DuckDB function', priority: 2, order: raw.length }))
  KEYWORDS.forEach((label) => raw.push({ label, kind: 'keyword', insertText: label, detail: 'SQL keyword', priority: 3, order: raw.length }))
  const seen = new Set<string>()
  return raw
    .map((item) => ({ item, score: matchScore(item.label, token) }))
    .filter((entry): entry is { item: typeof raw[number]; score: number } => entry.score !== null)
    .sort((a, b) => a.item.priority - b.item.priority || a.score - b.score || a.item.order - b.item.order)
    .filter(({ item }) => { const key = item.label.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true })
    .map(({ item }, index) => { const { priority: _priority, order: _order, ...suggestion } = item; return { ...suggestion, sortText: index.toString().padStart(4, '0') } })
}
