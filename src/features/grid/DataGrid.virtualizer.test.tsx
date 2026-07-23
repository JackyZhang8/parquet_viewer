import { render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

const virtualizerOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: Record<string, unknown>) => {
    virtualizerOptions.push(options)
    return {
      getVirtualItems: () => [],
      getTotalSize: () => 0,
      resizeItem: vi.fn(),
      scrollToIndex: vi.fn(),
      options,
    }
  },
}))

import { DataGrid } from './DataGrid'

it('disables synchronous virtualizer rerenders under React 19', () => {
  render(<DataGrid queryKey="empty" columns={[]} rows={[]} status="idle" done />)

  expect(virtualizerOptions.length).toBeGreaterThanOrEqual(2)
  expect(virtualizerOptions.every((options) => options.useFlushSync === false)).toBe(true)
})
