import { describe, expect, it } from 'vitest'
import { isSessionScalar, type ColumnSchema, type SessionFilter } from '../../domain/types'
import { buildFilterQueryRequest, columnFamily, convertEditorValue, operatorsFor } from './filterSql'

const col = (logicalType: string, name = 'value'): ColumnSchema => ({ name, logicalType, nullable: true })

describe('columnFamily', () => {
  it.each([
    ['BOOLEAN', 'boolean'], ['BOOL', 'boolean'], ['STRING', 'text'], ['UTF8', 'text'],
    ['VARCHAR', 'text'], ['CHAR', 'text'], ['DATE', 'temporal'], ['TIME_MICROS', 'temporal'],
    ['TIMESTAMP_NANOS', 'temporal'], ['INT96', 'temporal'], ['INT32', 'signedInteger'],
    ['INT64', 'signedInteger'], ['UINT64', 'unsignedInteger'], ['FLOAT', 'float'], ['DOUBLE', 'float'],
    ['INTEGER { BIT_WIDTH: 32, IS_SIGNED: TRUE }', 'signedInteger'],
    ['INTEGER { BIT_WIDTH: 64, IS_SIGNED: FALSE }', 'unsignedInteger'],
    ['BINARY', 'binary'], ['FIXED_BINARY', 'binary'], ['BLOB', 'binary'],
    ['STRUCT', 'nested'], ['LIST', 'nested'], ['MAP', 'nested'], ['ARRAY', 'nested'], ['UNION', 'nested'],
    ['MYSTERY', 'unsupported'], ['DECIMAL(0,0)', 'unsupported'],
    ['DECIMAL(4,5)', 'unsupported'], ['DECIMAL(39,0)', 'unsupported'], ['decimal(9,2)', 'unsupported'],
  ])('%s maps to %s', (logicalType, family) => expect(columnFamily(col(logicalType)).kind).toBe(family))

  it('parses valid decimal precision and scale', () => {
    expect(columnFamily(col('DECIMAL(24,4)'))).toEqual({ kind: 'decimal', precision: 24, scale: 4 })
  })
})

it('exposes only backend-supported operators', () => {
  expect(operatorsFor(col('VARCHAR'))).toEqual(['eq','notEq','contains','startsWith','endsWith','lt','lte','gt','gte','isNull','isNotNull'])
  expect(operatorsFor(col('BOOLEAN'))).toEqual(['eq','notEq','isNull','isNotNull'])
  expect(operatorsFor(col('INT96'))).toEqual(['eq','notEq','lt','lte','gt','gte','isNull','isNotNull'])
  expect(operatorsFor(col('BINARY'))).toEqual(['isNull','isNotNull'])
  expect(operatorsFor(col('LIST'))).toEqual(['isNull','isNotNull'])
  expect(operatorsFor(col('STRUCT'))).toEqual(['isNull','isNotNull'])
})

describe('convertEditorValue', () => {
  it('preserves exact scalar values', () => {
    expect(convertEditorValue(col('BOOLEAN'), 'true')).toEqual({ type: 'boolean', value: true })
    expect(convertEditorValue(col('UINT64'), '18446744073709551615')).toEqual({ type: 'integer', value: '18446744073709551615' })
    expect(convertEditorValue(col('INT64'), '-9223372036854775808')).toEqual({ type: 'integer', value: '-9223372036854775808' })
    expect(convertEditorValue(col('DECIMAL(20,4)'), '1234567890123456.1234')).toEqual({ type: 'decimal', value: '1234567890123456.1234' })
    expect(convertEditorValue(col('DOUBLE'), '1.25')).toEqual({ type: 'number', value: 1.25 })
    expect(convertEditorValue(col('DOUBLE'), '1.0')).toEqual({ type: 'integer', value: '1' })
    expect(convertEditorValue(col('DOUBLE'), '1e3')).toEqual({ type: 'integer', value: '1000' })
    expect(convertEditorValue(col('DOUBLE'), '-0')).toEqual({ type: 'integer', value: '0' })
    expect(convertEditorValue(col('DOUBLE'), '9007199254740993')).toEqual({ type: 'integer', value: '9007199254740993' })
    expect(convertEditorValue(col('DATE'), '2026-07-12')).toEqual({ type: 'string', value: '2026-07-12' })
    expect(convertEditorValue(col('INT8'), '128')).toEqual({ type: 'integer', value: '128' })
  })

  it.each(['1.0','1e3','-0','0.5'])('always emits a valid session scalar for float %s', (raw) => {
    expect(isSessionScalar(convertEditorValue(col('DOUBLE'), raw))).toBe(true)
  })

  it.each([
    ['UINT64', '-1', 'unsigned'], ['INT8', '9223372036854775808', 'signed'],
    ['UINT8', '18446744073709551616', 'unsigned'],
    ['DECIMAL(5,2)', '1234.00', 'precision'], ['DECIMAL(5,2)', '1.234', 'scale'],
    ['DOUBLE', 'Infinity', 'finite'], ['BOOLEAN', 'yes', 'boolean'], ['INT32', '01', 'canonical'],
  ])('rejects invalid %s input', (type, value, message) => {
    expect(() => convertEditorValue(col(type), value)).toThrow(new RegExp(message, 'i'))
  })
})

describe('buildFilterQueryRequest', () => {
  const columns = [col('INT64', 'id'), col('VARCHAR', 'name'), col('STRUCT', 'nested')]
  it('builds exact wire conditions and omits null values', () => {
    const filters: SessionFilter[] = [
      { column: 'id', operator: 'gte', value: { type: 'integer', value: '4' } },
      { column: 'name', operator: 'isNull', value: { type: 'null' } },
    ]
    expect(buildFilterQueryRequest(columns, filters, [{ column: 'name', direction: 'desc' }], 500)).toEqual({
      selectedColumns: [], previewLimit: 500, sorts: [{ column: 'name', direction: 'desc' }],
      filters: [{ column: 'id', operator: 'gte', value: { type: 'integer', value: '4' } }, { column: 'name', operator: 'isNull' }],
    })
  })

  it('passes equality null scalars through for backend null rewriting', () => {
    expect(buildFilterQueryRequest(columns, [
      { column:'id', operator:'eq', value:{type:'null'} },
      { column:'name', operator:'notEq', value:{type:'null'} },
    ], [], 10).filters).toEqual([
      { column:'id', operator:'eq', value:{type:'null'} },
      { column:'name', operator:'notEq', value:{type:'null'} },
    ])
    expect(() => buildFilterQueryRequest(columns, [{column:'id',operator:'lt',value:{type:'null'}}], [], 10)).toThrow(/null.*equality/i)
  })

  it('rejects limits, duplicate sorts, unknown columns, and incompatible conditions', () => {
    expect(() => buildFilterQueryRequest(columns, [], [], 0)).toThrow(/preview/i)
    expect(() => buildFilterQueryRequest(columns, [], [{column:'id',direction:'asc'},{column:'id',direction:'desc'}], 1)).toThrow(/duplicate/i)
    expect(() => buildFilterQueryRequest(columns, [{column:'nested',operator:'eq',value:{type:'string',value:'x'}}], [], 1)).toThrow(/incompatible/i)
    expect(() => buildFilterQueryRequest(columns, [{column:'missing',operator:'isNull',value:{type:'null'}}], [], 1)).toThrow(/unknown/i)
    expect(() => buildFilterQueryRequest(columns, Array.from({length:101},()=>({column:'id',operator:'eq',value:{type:'integer',value:'1'}})), [], 1)).toThrow(/100/)
  })
})
