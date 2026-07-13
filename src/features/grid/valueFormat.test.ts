import { expect, it } from 'vitest'
import { formatCellValue, formatTsvValue, truncateDisplay } from './valueFormat'

it.each([
  [null, 'NULL', 'null'],
  ['', '“”', 'empty'],
  [true, 'true', 'boolean'],
  [42, '42', 'number'],
  ['9007199254740993', '9007199254740993', 'integer'],
  ['2026-07-13T10:20:30Z', '2026-07-13T10:20:30Z', 'date'],
  [{ encoding: 'base64', value: 'AQID' }, 'BLOB · 3 bytes', 'blob'],
  [[1, { b: 2, a: 1 }], '[1,{"a":1,"b":2}]', 'nested'],
])('formats %j without lossy coercion', (value, display, kind) => {
  expect(formatCellValue(value)).toMatchObject({ display, full: display, kind })
})

it('stably formats nested keys and safely falls back for unsupported values', () => {
  expect(formatCellValue({ z: { b: 2, a: 1 }, a: true }).full).toBe('{"a":true,"z":{"a":1,"b":2}}')
  expect(formatCellValue(Symbol('x') as never).display).toBe('[Unsupported]')
})

it('truncates by Unicode characters without splitting surrogate pairs while retaining full detail', () => {
  expect(truncateDisplay('😀😀😀', 2)).toBe('😀…')
  expect(formatCellValue('😀😀😀', 2)).toEqual({ display: '😀…', full: '😀😀😀', kind: 'string', truncated: true })
})

it('escapes clipboard TSV predictably', () => {
  expect(formatTsvValue(null)).toBe('NULL')
  expect(formatTsvValue('')).toBe('')
  expect(formatTsvValue('a\tb\nc\r')).toBe('a\\tb\\nc\\r')
})
