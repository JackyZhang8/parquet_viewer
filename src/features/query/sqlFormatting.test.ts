import { expect, it } from 'vitest'
import { formatSql } from './sqlFormatting'

it('formats major clauses while preserving strings, quoted identifiers, and comments', () => {
  expect(formatSql(`select "order value", 'from here' as note from data left join data d on d.id=data.id where note='a  b' group by "order value", note having count(*)>1 order by "order value" limit 10 -- from comment`)).toBe(
    `SELECT "order value", 'from here' AS note\nFROM data\nLEFT JOIN data d ON d.id = data.id\nWHERE note = 'a  b'\nGROUP BY "order value", note\nHAVING count(*) > 1\nORDER BY "order value"\nLIMIT 10 -- from comment`,
  )
})

it('handles empty and malformed SQL without throwing', () => {
  expect(formatSql('')).toBe('')
  expect(formatSql('select (')).toBe('SELECT (')
  expect(formatSql("select 'unterminated")).toBe("SELECT 'unterminated")
})

it('preserves the newline that terminates a line comment', () => {
  expect(formatSql('select 1 -- from here\nfrom data')).toBe('SELECT 1 -- from here\nFROM data')
  expect(formatSql('select 1 -- keep addition outside comment\n+ 2')).toBe('SELECT 1 -- keep addition outside comment\n+ 2')
  expect(formatSql('select 1 /* from remains a comment */ + 2')).toBe('SELECT 1 /* from remains a comment */ + 2')
})

it('preserves dollar-quoted literals including tags, multiline text, and unterminated bodies', () => {
  expect(formatSql('select $$from where\nselect$$ as body from data')).toBe('SELECT $$from where\nselect$$ AS body\nFROM data')
  expect(formatSql('select $tag$order by x$tag$ from data')).toBe('SELECT $tag$order by x$tag$\nFROM data')
  expect(formatSql('select $$unterminated from where')).toBe('SELECT $$unterminated from where')
})
