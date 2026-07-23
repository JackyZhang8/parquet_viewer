import { describe, expect, it } from 'vitest'
import type { WorkspaceTab } from '../stores/workspace'
import { selectNextFileChangeCandidate } from './fileChangePolling'

const tab = (id: string, status: WorkspaceTab['status'] = 'ready'): WorkspaceTab => ({
  id,
  fileId: `file-${id}`,
  path: `/${id}.parquet`,
  status,
  sqlDraft: '',
  filters: [],
  sorts: [],
  viewState: { scrollTop: 0, scrollLeft: 0, sidebarWidth: 260, editorHeight: 180 },
})

describe('selectNextFileChangeCandidate', () => {
  it('selects the active ready tab first', () => {
    expect(selectNextFileChangeCandidate([tab('a'), tab('b')], 'b', new Set(), 0)).toEqual({
      tab: tab('b'),
      nextCursor: 1,
    })
  })

  it('checks one eligible tab per tick in round-robin order', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    const first = selectNextFileChangeCandidate(tabs, 'a', new Set(), 0)
    const second = selectNextFileChangeCandidate(tabs, 'a', new Set(), first.nextCursor)
    const third = selectNextFileChangeCandidate(tabs, 'a', new Set(), second.nextCursor)

    expect([first.tab?.id, second.tab?.id, third.tab?.id]).toEqual(['a', 'b', 'c'])
  })

  it('skips tabs that are not ready or have been ignored', () => {
    expect(selectNextFileChangeCandidate(
      [tab('loading', 'loading'), tab('ignored'), tab('ready')],
      'loading',
      new Set(['file-ignored']),
      0,
    )).toEqual({ tab: tab('ready'), nextCursor: 0 })
  })

  it('resets the cursor when no tabs are eligible', () => {
    expect(selectNextFileChangeCandidate([tab('a', 'error')], 'a', new Set(), 7)).toEqual({
      tab: undefined,
      nextCursor: 0,
    })
  })
})
