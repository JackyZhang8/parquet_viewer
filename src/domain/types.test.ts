import { describe, expect, it } from 'vitest'

import {
  isAppError,
  isQueryBatch,
  isSessionScalar,
  sessionInteger,
  sessionScalarFromNumber,
} from './types'

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
})
