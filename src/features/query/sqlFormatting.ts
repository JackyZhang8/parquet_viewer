const protectSql = (sql: string): { text: string; protectedParts: string[] } => {
  const protectedParts: string[] = []
  let text = ''
  for (let index = 0; index < sql.length;) {
    const char = sql[index]; const next = sql[index + 1]
    let end = index
    if (char === "'" || char === '"') {
      const quote = char; end += 1
      while (end < sql.length) {
        if (sql[end] === quote && sql[end + 1] === quote) { end += 2; continue }
        if (sql[end] === quote) { end += 1; break }
        end += 1
      }
    } else if (char === '-' && next === '-') {
      end = sql.indexOf('\n', index); end = end < 0 ? sql.length : end + 1
    } else if (char === '/' && next === '*') {
      const close = sql.indexOf('*/', index + 2); end = close < 0 ? sql.length : close + 2
    }
    if (end > index) {
      const marker = `\uE000${protectedParts.length}\uE001`
      protectedParts.push(sql.slice(index, end)); text += marker; index = end
    } else { text += char; index += 1 }
  }
  return { text, protectedParts }
}

export const formatSql = (sql: string): string => {
  if (!sql.trim()) return ''
  const { text: protectedSql, protectedParts } = protectSql(sql)
  let formatted = protectedSql.trim().replace(/\s+/g, ' ')
  const keywords = [
    'full outer join', 'left outer join', 'right outer join', 'inner join', 'full join', 'left join', 'right join',
    'group by', 'order by', 'select', 'from', 'where', 'having', 'limit', 'join', 'on', 'as', 'and', 'or', 'not',
  ]
  for (const keyword of keywords) {
    const pattern = keyword.replace(' ', '\\s+')
    formatted = formatted.replace(new RegExp(`\\b${pattern}\\b`, 'gi'), keyword.toUpperCase())
  }
  formatted = formatted
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*(<>|!=|<=|>=|=|<|>)\s*/g, ' $1 ')
    .replace(/\s+(FULL OUTER JOIN|LEFT OUTER JOIN|RIGHT OUTER JOIN|INNER JOIN|FULL JOIN|LEFT JOIN|RIGHT JOIN|JOIN|FROM|WHERE|GROUP BY|HAVING|ORDER BY|LIMIT)\b/g, '\n$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim()
  return formatted.replace(/\uE000(\d+)\uE001/g, (_marker, index: string) => protectedParts[Number(index)])
}
