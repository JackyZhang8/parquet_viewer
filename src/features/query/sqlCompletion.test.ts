import { describe, expect, it } from 'vitest'
import type { ColumnSchema } from '../../domain/types'
import { getSqlCompletions, quoteSqlIdentifier } from './sqlCompletion'

const columns: ColumnSchema[] = [
  { name: 'id', logicalType: 'INT64', nullable: false },
  { name: 'order value', logicalType: 'VARCHAR', nullable: true },
  { name: 'created_at', logicalType: 'TIMESTAMP', nullable: false },
]

const labels = (sql: string) => getSqlCompletions(sql, sql.length, columns).map((item) => item.label)

describe('SQL completion', () => {
  it('prioritizes the fixed data table after FROM and JOIN', () => {
    expect(labels('SELECT * FROM ')[0]).toBe('data')
    expect(labels('SELECT * FROM data JOIN ')[0]).toBe('data')
  })

  it.each(['SELECT ', 'SELECT * FROM data WHERE ', 'GROUP BY ', 'HAVING ', 'ORDER BY '])(
    'prioritizes fields in %s context', (sql) => expect(labels(sql).slice(0, 3)).toEqual(['id', 'order value', 'created_at']),
  )

  it('quotes special identifiers and escapes embedded quotes', () => {
    expect(quoteSqlIdentifier('simple_name')).toBe('simple_name')
    expect(quoteSqlIdentifier('order value')).toBe('"order value"')
    expect(quoteSqlIdentifier('say"hi')).toBe('"say""hi"')
    expect(getSqlCompletions('SELECT ord', 10, columns)[0]).toMatchObject({ label: 'order value', insertText: '"order value"' })
  })

  it('uses deterministic subsequence matching and exposes function snippets', () => {
    expect(labels('SELECT cat')[0]).toBe('created_at')
    expect(getSqlCompletions('SELECT cou', 10, columns).find((item) => item.label === 'count')).toMatchObject({
      insertText: 'count(${1:*})', insertTextRules: 'snippet', kind: 'function',
    })
    expect(getSqlCompletions('SELECT date_t', 13, columns).find((item) => item.label === 'date_trunc')?.insertText)
      .toBe("date_trunc('${1:day}', ${2:column})")
  })

  it('is safe for empty/malformed SQL and suppresses strings and comments', () => {
    expect(getSqlCompletions('', 0, columns).length).toBeGreaterThan(0)
    expect(getSqlCompletions('SELECT ((', 9, columns).length).toBeGreaterThan(0)
    expect(getSqlCompletions("SELECT 'not here", 16, columns)).toEqual([])
    expect(getSqlCompletions('SELECT -- not here', 18, columns)).toEqual([])
    expect(getSqlCompletions('SELECT /* not here', 18, columns)).toEqual([])
  })

  it('only uses the columns passed by the active tab', () => {
    expect(labels('SELECT ')).not.toContain('inactive_only')
    expect(getSqlCompletions('SELECT ', 7, [{ name: 'inactive_only', logicalType: 'BOOLEAN', nullable: true }])[0].label)
      .toBe('inactive_only')
  })
})
