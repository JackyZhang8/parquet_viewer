import type { WorkspaceTab } from '../stores/workspace'

export interface FileChangeCandidate {
  tab: WorkspaceTab | undefined
  nextCursor: number
}

export const selectNextFileChangeCandidate = (
  tabs: WorkspaceTab[],
  activeTabId: string | null,
  ignoredFileIds: ReadonlySet<string>,
  cursor: number,
): FileChangeCandidate => {
  const eligible = tabs.filter((tab) => tab.status === 'ready' && !ignoredFileIds.has(tab.fileId))
  if (!eligible.length) return { tab: undefined, nextCursor: 0 }

  const active = eligible.find((tab) => tab.id === activeTabId)
  const ordered = active ? [active, ...eligible.filter((tab) => tab.id !== active.id)] : eligible
  const index = cursor % ordered.length
  return { tab: ordered[index], nextCursor: (index + 1) % ordered.length }
}
