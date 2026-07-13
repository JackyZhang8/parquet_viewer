import type { ColumnSchema, FilterOperator, FilterQueryRequest, SessionFilter, SessionScalar, SessionSort } from '../../domain/types'
import { sessionDecimal, sessionInteger, sessionScalarFromNumber } from '../../domain/types'

export type ColumnFamily =
  | { kind: 'boolean' | 'text' | 'temporal' | 'float' | 'binary' | 'nested' | 'unsupported' }
  | { kind: 'signedInteger' | 'unsignedInteger' }
  | { kind: 'decimal'; precision: number; scale: number }

const integerFamily = (type: string): ColumnFamily | undefined => {
  const plain = /^(U?)INT(8|16|32|64)$/.exec(type)
  if (plain) return { kind: plain[1] ? 'unsignedInteger' : 'signedInteger' }
  const debug = /^INTEGER \{ BIT_WIDTH: (8|16|32|64), IS_SIGNED: (TRUE|FALSE) \}$/.exec(type)
  if (debug) return { kind: debug[2] === 'TRUE' ? 'signedInteger' : 'unsignedInteger' }
}

export const columnFamily = (column: ColumnSchema): ColumnFamily => {
  const type = column.logicalType
  if (type === 'BOOLEAN' || type === 'BOOL') return { kind: 'boolean' }
  if (['STRING','UTF8','VARCHAR','CHAR'].includes(type)) return { kind: 'text' }
  if (type === 'DATE' || type === 'INT96' || /^TIME(?:STAMP)?_(?:MILLIS|MICROS|NANOS)$/.test(type) ||
    /^TIME \{ IS_ADJUSTED_TO_U_T_C: (?:TRUE|FALSE), UNIT: (?:MILLIS|MICROS|NANOS) \}$/.test(type)) return { kind: 'temporal' }
  if (type === 'FLOAT' || type === 'DOUBLE') return { kind: 'float' }
  if (['BINARY','FIXED_BINARY','BLOB'].includes(type)) return { kind: 'binary' }
  if (['STRUCT','LIST','MAP','ARRAY','UNION'].includes(type)) return { kind: 'nested' }
  const integer = integerFamily(type)
  if (integer) return integer
  const decimal = /^DECIMAL\((\d+),(\d+)\)$/.exec(type)
  if (decimal) {
    const precision = Number(decimal[1]); const scale = Number(decimal[2])
    if (precision > 0 && precision <= 38 && scale <= precision) return { kind: 'decimal', precision, scale }
  }
  return { kind: 'unsupported' }
}

const NULL_OPERATORS: FilterOperator[] = ['isNull','isNotNull']
const ORDERED: FilterOperator[] = ['eq','notEq','lt','lte','gt','gte']
export const operatorsFor = (column: ColumnSchema): FilterOperator[] => {
  switch (columnFamily(column).kind) {
    case 'text': return ['eq','notEq','contains','startsWith','endsWith','lt','lte','gt','gte',...NULL_OPERATORS]
    case 'boolean': return ['eq','notEq',...NULL_OPERATORS]
    case 'signedInteger': case 'unsignedInteger': case 'float': case 'decimal': case 'temporal': return [...ORDERED,...NULL_OPERATORS]
    default: return [...NULL_OPERATORS]
  }
}

const integerRange = (value: string, signed: boolean) => {
  let parsed: bigint
  try { parsed = BigInt(value) } catch { throw new Error('Integer must use canonical decimal syntax') }
  const max = BigInt(signed ? '9223372036854775807' : '18446744073709551615')
  const min = signed ? BigInt('-9223372036854775808') : BigInt(0)
  if (parsed < min || parsed > max) throw new Error(`Integer is outside the supported ${signed ? 'signed i64' : 'unsigned u64'} range`)
}

export const convertEditorValue = (column: ColumnSchema, raw: string): SessionScalar => {
  const family = columnFamily(column)
  switch (family.kind) {
    case 'boolean':
      if (raw !== 'true' && raw !== 'false') throw new Error('Boolean value must be true or false')
      return { type: 'boolean', value: raw === 'true' }
    case 'signedInteger': case 'unsignedInteger': {
      integerRange(raw, family.kind === 'signedInteger')
      return sessionInteger(raw)
    }
    case 'decimal': {
      const scalar = sessionDecimal(raw)
      const unsigned = raw.startsWith('-') ? raw.slice(1) : raw
      const [whole, fraction = ''] = unsigned.split('.')
      const integerDigits = whole === '0' ? 0 : whole.length
      if (fraction.length > family.scale) throw new Error(`Decimal exceeds scale ${family.scale}`)
      if (integerDigits > family.precision - family.scale || integerDigits + fraction.length > family.precision) throw new Error(`Decimal exceeds precision ${family.precision}`)
      return scalar
    }
    case 'float': {
      if (raw.length === 0) throw new Error('Float value must be finite')
      if (/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(raw)) return sessionInteger(raw)
      const value = Number(raw)
      if (!Number.isFinite(value)) throw new Error('Float value must be finite')
      return sessionScalarFromNumber(value)
    }
    case 'text': case 'temporal': return { type: 'string', value: raw }
    default: throw new Error('This column type only supports null predicates')
  }
}

const compatibleScalar = (column: ColumnSchema, scalar: SessionScalar) => {
  const kind = columnFamily(column).kind
  return (kind === 'boolean' && scalar.type === 'boolean') ||
    ((kind === 'signedInteger' || kind === 'unsignedInteger') && scalar.type === 'integer') ||
    (kind === 'decimal' && (scalar.type === 'decimal' || scalar.type === 'integer')) ||
    (kind === 'float' && (scalar.type === 'number' || scalar.type === 'integer')) ||
    ((kind === 'text' || kind === 'temporal') && scalar.type === 'string')
}

const validateScalar = (column: ColumnSchema, scalar: SessionScalar) => {
  if (!compatibleScalar(column, scalar)) throw new Error(`Filter value is incompatible with “${column.name}”`)
  if (scalar.type === 'integer' || scalar.type === 'decimal') convertEditorValue(column, scalar.value)
  if (scalar.type === 'number' && (!Number.isFinite(scalar.value) || Number.isInteger(scalar.value))) {
    throw new Error(`Filter value is incompatible with “${column.name}”`)
  }
}

export const buildFilterQueryRequest = (columns: ColumnSchema[], filters: SessionFilter[], sorts: SessionSort[], previewLimit: number): FilterQueryRequest => {
  if (!Number.isInteger(previewLimit) || previewLimit < 1 || previewLimit > 100000) throw new Error('Preview limit must be between 1 and 100000')
  if (filters.length > 100) throw new Error('At most 100 filter conditions are allowed')
  if (sorts.length > 3) throw new Error('At most three sort columns are allowed')
  const byName = new Map(columns.map((column) => [column.name, column]))
  const seenSorts = new Set<string>()
  for (const sort of sorts) {
    if (!byName.has(sort.column)) throw new Error(`Sort references unknown column “${sort.column}”`)
    if (seenSorts.has(sort.column)) throw new Error('Sort columns contain a duplicate')
    seenSorts.add(sort.column)
  }
  const wireFilters = filters.map((filter) => {
    const column = byName.get(filter.column)
    if (!column) throw new Error(`Filter references unknown column “${filter.column}”`)
    if (!operatorsFor(column).includes(filter.operator)) throw new Error(`Operator is incompatible with “${filter.column}”`)
    if (filter.operator === 'isNull' || filter.operator === 'isNotNull') return { column: filter.column, operator: filter.operator }
    if (filter.value.type === 'null') {
      if (filter.operator === 'eq' || filter.operator === 'notEq') return { column: filter.column, operator: filter.operator, value: filter.value }
      throw new Error('Null is only valid with equality operators')
    }
    validateScalar(column, filter.value)
    return { column: filter.column, operator: filter.operator, value: filter.value }
  })
  return { selectedColumns: [], filters: wireFilters, sorts: [...sorts], previewLimit }
}
