export const dollarDelimiterAt = (sql: string, index: number): string | null => {
  if (sql[index] !== '$') return null
  const close = sql.indexOf('$', index + 1)
  if (close < 0) return null
  const tag = sql.slice(index + 1, close)
  return tag === '' || /^[A-Za-z_][A-Za-z0-9_]*$/.test(tag) ? sql.slice(index, close + 1) : null
}
