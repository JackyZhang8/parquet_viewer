import { useMemo, useState } from 'react'
import type { WorkspaceTab } from '../../stores/workspace'

interface FileTabsProps {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  onActivate(id: string): void
  onClose(id: string): void
  onCloseOthers(id: string): void
  onCloseRight(id: string): void
  onReveal(path: string): void
}

const size = (tab: WorkspaceTab) => tab.metadata
  ? `${(Number(tab.metadata.sizeBytes) / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`
  : ''

export function FileTabs(props: FileTabsProps) {
  const [filesOpen, setFilesOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [menuTab, setMenuTab] = useState<WorkspaceTab | null>(null)
  const filtered = useMemo(() => props.tabs.filter((tab) => tab.path.toLowerCase().includes(search.toLowerCase())), [props.tabs, search])
  const keyDown = (event: React.KeyboardEvent, tab: WorkspaceTab, index: number) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onActivate(tab.id) }
    if (event.key === 'Delete') { event.preventDefault(); props.onClose(tab.id) }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      const offset = event.key === 'ArrowRight' ? 1 : -1
      props.onActivate(props.tabs[(index + offset + props.tabs.length) % props.tabs.length].id)
    }
  }
  const menuAction = (action: () => void | Promise<void>) => { void action(); setMenuTab(null) }
  return (
    <div className="tabs-bar">
      <div className="file-tabs" role="tablist" aria-label="Open files">
        {props.tabs.map((tab, index) => (
          <div key={tab.id} role="tab" tabIndex={tab.id === props.activeTabId ? 0 : -1}
            aria-selected={tab.id === props.activeTabId}
            aria-label={tab.metadata?.name ?? tab.path.split(/[\\/]/).pop()}
            title={`${tab.path}${size(tab) ? ` · ${size(tab)}` : ''}`}
            className={`file-tab ${tab.id === props.activeTabId ? 'active' : ''} ${tab.status}`}
            onClick={() => props.onActivate(tab.id)} onKeyDown={(event) => keyDown(event, tab, index)}
            onAuxClick={(event) => { if (event.button === 1) props.onClose(tab.id) }}
            onContextMenu={(event) => { event.preventDefault(); setMenuTab(tab) }}>
            <span className="status-dot" aria-hidden="true" />
            <span className="tab-name">{tab.metadata?.name ?? tab.path.split(/[\\/]/).pop()}</span>
            <button className="tab-close" aria-label={`Close ${tab.metadata?.name ?? tab.path}`} onClick={(event) => { event.stopPropagation(); props.onClose(tab.id) }}>×</button>
          </div>
        ))}
      </div>
      <div className="files-menu-wrap">
        <button className="files-menu-button" aria-expanded={filesOpen} onClick={() => setFilesOpen((open) => !open)}>Opened files</button>
        {filesOpen && <div className="files-popover">
          <input type="search" aria-label="Search opened files" placeholder="Search files" value={search} onChange={(event) => setSearch(event.target.value)} />
          <div role="listbox" aria-label="Opened files">
            {filtered.map((tab) => <button role="option" aria-selected={tab.id === props.activeTabId} key={tab.id} title={tab.path}
              onClick={() => { props.onActivate(tab.id); setFilesOpen(false) }}>{tab.metadata?.name ?? tab.path}</button>)}
          </div>
        </div>}
      </div>
      {menuTab && <div role="menu" className="tab-menu">
        <button role="menuitem" onClick={() => menuAction(() => props.onClose(menuTab.id))}>Close</button>
        <button role="menuitem" onClick={() => menuAction(() => props.onCloseOthers(menuTab.id))}>Close others</button>
        <button role="menuitem" onClick={() => menuAction(() => props.onCloseRight(menuTab.id))}>Close right</button>
        <button role="menuitem" onClick={() => menuAction(() => navigator.clipboard?.writeText(menuTab.path))}>Copy path</button>
        <button role="menuitem" onClick={() => menuAction(() => props.onReveal(menuTab.path))}>Reveal in file manager</button>
      </div>}
    </div>
  )
}
