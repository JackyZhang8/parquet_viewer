import { describe, expect, it } from 'vitest'

import { isAppError, isQueryBatch } from './types'

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
})
