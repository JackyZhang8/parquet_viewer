import { describe, expect, it, vi } from 'vitest'

import {
  isAppError,
  isQueryBatch,
  isSessionScalar,
  sessionDecimal,
  sessionInteger,
  sessionScalarFromNumber,
} from './types'
import type { FilterCondition, RestoredSession } from './types'

const restoredSessionShape: RestoredSession = {
  snapshot: { version: 1, tabs: [], activeTabId: null },
  unavailableTabIds: ['tab-1'],
  warning: null,
}
void restoredSessionShape

const nullFilter = { column: 'deleted_at', operator: 'isNull' } satisfies FilterCondition
const valueFilter = {
  column: 'status',
  operator: 'eq',
  value: { type: 'string', value: 'paid' },
} satisfies FilterCondition
// @ts-expect-error Null predicates cannot carry a value.
const invalidNullFilter: FilterCondition = { column: 'deleted_at', operator: 'isNull', value: { type: 'null' } }
// @ts-expect-error Value predicates require a scalar.
const invalidValueFilter: FilterCondition = { column: 'status', operator: 'eq' }
void [nullFilter, valueFilter, invalidNullFilter, invalidValueFilter]

describe('IPC runtime guards', () => {
  it('accepts the stable public error shape and rejects debug-shaped errors', () => {
    expect(
      isAppError({
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred',
        detail: null,
      }),
    ).toBe(true)
    expect(isAppError({ code: 'INTERNAL_ERROR', debug: '/private/file.parquet' })).toBe(false)
  })

  it('validates canonical exact decimal scalar strings', () => {
    expect(sessionDecimal('-123.45')).toEqual({ type: 'decimal', value: '-123.45' })
    expect(isSessionScalar({ type: 'decimal', value: '0.001' })).toBe(true)
    for (const value of ['', '+1', '01', '-0', '-0.0', '.1', '1.', '1e2', ' 1']) {
      expect(() => sessionDecimal(value)).toThrow(/decimal/i)
      expect(isSessionScalar({ type: 'decimal', value })).toBe(false)
    }
  })

  it('accepts INVALID_ARGUMENT as a public error code', () => {
    expect(isAppError({ code: 'INVALID_ARGUMENT', message: 'Invalid filter', detail: null })).toBe(true)
  })

  it('accepts precision-safe query batches and rejects numeric counters', () => {
    expect(
      isQueryBatch({
        queryId: 'query-1',
        rows: [[9_007_199_254_740_991, '9223372036854775807', 3.5, null]],
        done: true,
        returnedRows: '4',
        elapsedMs: '12',
      }),
    ).toBe(true)
    expect(
      isQueryBatch({
        queryId: 'query-1',
        rows: [],
        done: true,
        returnedRows: 3,
        elapsedMs: 12,
      }),
    ).toBe(false)
  })

  it('constructs tagged session numbers without losing integer precision', () => {
    expect(sessionScalarFromNumber(42)).toEqual({ type: 'integer', value: '42' })
    expect(sessionScalarFromNumber(Number.MAX_SAFE_INTEGER)).toEqual({
      type: 'integer',
      value: '9007199254740991',
    })
    expect(sessionScalarFromNumber(3.5)).toEqual({ type: 'number', value: 3.5 })
    expect(() => sessionScalarFromNumber(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /explicit decimal integer string/,
    )
    expect(() => sessionScalarFromNumber(Number.POSITIVE_INFINITY)).toThrow(/finite/)
  })

  it('validates explicit lossless session integers and scalar shapes', () => {
    expect(sessionInteger('9007199254740992')).toEqual({
      type: 'integer',
      value: '9007199254740992',
    })
    expect(sessionInteger('9223372036854775807')).toEqual({
      type: 'integer',
      value: '9223372036854775807',
    })
    expect(sessionInteger('18446744073709551615')).toEqual({
      type: 'integer',
      value: '18446744073709551615',
    })
    expect(() => sessionInteger('01')).toThrow(/canonical/)
    expect(() => sessionInteger('18446744073709551616')).toThrow(/range/)
    expect(isSessionScalar({ type: 'number', value: 42 })).toBe(false)
    expect(isSessionScalar({ type: 'string', value: '42' })).toBe(true)
  })

  it('validates integer ranges without requiring the BigInt runtime', () => {
    vi.stubGlobal('BigInt', undefined)
    try {
      expect(sessionInteger('-9223372036854775808')).toEqual({ type: 'integer', value: '-9223372036854775808' })
      expect(sessionInteger('18446744073709551615')).toEqual({ type: 'integer', value: '18446744073709551615' })
      expect(() => sessionInteger('-9223372036854775809')).toThrow(/range/)
      expect(() => sessionInteger('18446744073709551616')).toThrow(/range/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
