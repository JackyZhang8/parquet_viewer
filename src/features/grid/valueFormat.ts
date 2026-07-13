import type { CellValue } from '../../domain/types'

export type CellKind = 'null' | 'empty' | 'boolean' | 'number' | 'integer' | 'date' | 'blob' | 'nested' | 'string' | 'unsupported'

export interface FormattedCell {
  display: string
  full: string
  kind: CellKind
  truncated?: boolean
}

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  }
  return value
}

const blobBytes = (base64: string) => {
  const cleaned = base64.replace(/\s/g, '')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cleaned)) return null
  return Math.max(0, Math.floor(cleaned.length * 3 / 4) - (cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0))
}

export const truncateDisplay = (value: string, maxCharacters = 120): string => {
  const characters = Array.from(value)
  if (characters.length <= maxCharacters) return value
  return `${characters.slice(0, Math.max(0, maxCharacters - 1)).join('')}…`
}

export const formatCellValue = (value: unknown, maxCharacters = 120): FormattedCell => {
  let full: string
  let kind: CellKind
  if (value === null) { full = 'NULL'; kind = 'null' }
  else if (value === '') { full = '“”'; kind = 'empty' }
  else if (typeof value === 'boolean') { full = String(value); kind = 'boolean' }
  else if (typeof value === 'number' && Number.isFinite(value)) { full = String(value); kind = 'number' }
  else if (typeof value === 'string') {
    full = value
    kind = /^-?(?:0|[1-9]\d*)$/.test(value) ? 'integer' :
      /^\d{4}-\d{2}-\d{2}(?:[T ][^\s]+)?$/.test(value) ? 'date' : 'string'
  } else if (value && typeof value === 'object' && !Array.isArray(value) &&
      (value as Record<string, unknown>).encoding === 'base64' && typeof (value as Record<string, unknown>).value === 'string') {
    const bytes = blobBytes((value as { value: string }).value)
    full = bytes === null ? 'BLOB · invalid base64' : `BLOB · ${bytes} bytes`; kind = 'blob'
  } else if (Array.isArray(value) || (value && typeof value === 'object')) {
    try { full = JSON.stringify(stable(value)); kind = 'nested' } catch { full = '[Unsupported]'; kind = 'unsupported' }
  } else { full = '[Unsupported]'; kind = 'unsupported' }
  const display = truncateDisplay(full, maxCharacters)
  return { display, full, kind, ...(display !== full ? { truncated: true } : {}) }
}

export const formatTsvValue = (value: CellValue | unknown): string => {
  if (value === null) return 'NULL'
  if (value === '') return ''
  const full = formatCellValue(value, Number.MAX_SAFE_INTEGER).full
  return full.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}
