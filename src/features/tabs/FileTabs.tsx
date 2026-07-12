import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceTab } from '../../stores/workspace'

interface FileTabsProps {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  onActivate(id: string): void
  onClose(id: string): void | Promise<void>
  onCloseOthers(id: string): void | Promise<void>
  onCloseRight(id: string): void | Promise<void>
  onReveal(path: string): void | Promise<void>
  onError?(key: string, error: unknown): void
}

const size = (tab: WorkspaceTab) => tab.metadata
  ? `${(Number(tab.metadata.sizeBytes) / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`
  : ''

export function FileTabs(props: FileTabsProps) {
  const [filesOpen, setFilesOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [menuTab, setMenuTab] = useState<WorkspaceTab | null>(null)
  const tablist = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const searchBox = useRef<HTMLInputElement>(null)
  const filtered = useMemo(() => props.tabs.filter((tab) => tab.path.toLowerCase().includes(search.toLowerCase())), [props.tabs, search])
  const keyDown = (event: React.KeyboardEvent, tab: WorkspaceTab, index: number) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onActivate(tab.id) }
    if (event.key === 'Delete') { event.preventDefault(); void run('Close file', () => props.onClose(tab.id)) }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? props.tabs.length - 1 :
        (index + (event.key === 'ArrowRight' ? 1 : -1) + props.tabs.length) % props.tabs.length
      props.onActivate(props.tabs[target].id)
      tablist.current?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus()
    }
  }
  const run = async (key: string, action: () => void | Promise<void>) => {
    try { await action() } catch (error) { props.onError?.(key, error) }
  }
  const menuAction = (key: string, action: () => void | Promise<void>) => { setMenuTab(null); void run(key, action) }
  useEffect(() => { if (menuTab) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus() }, [menuTab])
  useEffect(() => { if (filesOpen) searchBox.current?.focus() }, [filesOpen])
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setMenuTab(null); setFilesOpen(false) } }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenuTab(null); setFilesOpen(false) } }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [])
  return (
    <div className="tabs-bar" ref={root}>
      <div className="file-tabs" role="tablist" aria-label="Open files" ref={tablist}>
        {props.tabs.map((tab, index) => (
          <div key={tab.id} className={`file-tab-wrap ${tab.id === props.activeTabId ? 'active' : ''} ${tab.status}`}>
            <button role="tab" tabIndex={tab.id === props.activeTabId ? 0 : -1} aria-selected={tab.id === props.activeTabId}
              aria-label={tab.metadata?.name ?? tab.path.split(/[\\/]/).pop()} title={`${tab.path}${size(tab) ? ` · ${size(tab)}` : ''}`}
              className="file-tab" onClick={() => props.onActivate(tab.id)} onKeyDown={(event) => keyDown(event, tab, index)}
              onAuxClick={(event) => { if (event.button === 1) void run('Close file', () => props.onClose(tab.id)) }}
              onContextMenu={(event) => { event.preventDefault(); setMenuTab(tab) }}>
              <span className="status-dot" aria-hidden="true" /><span className="tab-name">{tab.metadata?.name ?? tab.path.split(/[\\/]/).pop()}</span>
            </button>
            <button className="tab-close" aria-label={`Close ${tab.metadata?.name ?? tab.path}`} onClick={() => void run('Close file', () => props.onClose(tab.id))}>×</button>
          </div>
        ))}
      </div>
      <div className="files-menu-wrap">
        <button className="files-menu-button" aria-expanded={filesOpen} onClick={() => setFilesOpen((open) => !open)}>Opened files</button>
        {filesOpen && <div className="files-popover">
          <input ref={searchBox} type="search" aria-label="Search opened files" placeholder="Search files" value={search} onChange={(event) => setSearch(event.target.value)} />
          <div role="listbox" aria-label="Opened files">
            {filtered.map((tab) => <button role="option" aria-selected={tab.id === props.activeTabId} key={tab.id} title={tab.path}
              onClick={() => { props.onActivate(tab.id); setFilesOpen(false) }}>{tab.metadata?.name ?? tab.path}</button>)}
          </div>
        </div>}
      </div>
      {menuTab && <div role="menu" className="tab-menu" ref={menu}>
        <button role="menuitem" onClick={() => menuAction('Close file', () => props.onClose(menuTab.id))}>Close</button>
        <button role="menuitem" onClick={() => menuAction('Close files', () => props.onCloseOthers(menuTab.id))}>Close others</button>
        <button role="menuitem" onClick={() => menuAction('Close files', () => props.onCloseRight(menuTab.id))}>Close right</button>
        <button role="menuitem" onClick={() => menuAction('Copy path', async () => { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(menuTab.path) })}>Copy path</button>
        <button role="menuitem" onClick={() => menuAction('Reveal file', () => props.onReveal(menuTab.path))}>Reveal in file manager</button>
      </div>}
    </div>
  )
}
