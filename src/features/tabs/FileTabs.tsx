import { useEffect, useRef, useState } from 'react'
import { labelsFor } from '../../app/labels'
import type { AppLanguage } from '../../domain/types'
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
  language?: AppLanguage
}

const size = (tab: WorkspaceTab) => tab.metadata
  ? `${(Number(tab.metadata.sizeBytes) / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`
  : ''

export function FileTabs(props: FileTabsProps) {
  const copy = labelsFor(props.language ?? 'en')
  const [menuState, setMenuState] = useState<{ tab: WorkspaceTab; x: number; y: number; invokerId: string } | null>(null)
  const [tabScrollState, setTabScrollState] = useState({ canLeft: false, canRight: false })
  const tablist = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const focusTab = (id: string) => {
    const exact = tablist.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(id)}"]`)
    ;(exact ?? tablist.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? tablist.current?.querySelector<HTMLElement>('[role="tab"]'))?.focus()
  }
  const openMenu = (tab: WorkspaceTab, invoker: HTMLElement, x: number, y: number) => {
    setMenuState({ tab, x, y, invokerId: invoker.dataset.tabId ?? tab.id })
  }
  const dismissMenu = (restoreFocus: boolean) => {
    const invokerId = menuState?.invokerId
    setMenuState(null)
    if (restoreFocus && invokerId) setTimeout(() => focusTab(invokerId), 0)
  }
  const keyDown = (event: React.KeyboardEvent<HTMLElement>, tab: WorkspaceTab, index: number) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onActivate(tab.id) }
    if (event.key === 'Delete') { event.preventDefault(); void run('Close file', () => props.onClose(tab.id)) }
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      openMenu(tab, event.currentTarget, rect.left, rect.bottom)
    }
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
  const syncScrollControls = () => {
    const element = tablist.current
    if (!element) return
    const next = {
      canLeft: element.scrollLeft > 0,
      canRight: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
    }
    setTabScrollState((current) => current.canLeft === next.canLeft && current.canRight === next.canRight ? current : next)
  }
  const scrollTabs = (direction: -1 | 1) => {
    const element = tablist.current
    if (!element) return
    element.scrollBy({ left: direction * Math.max(element.clientWidth * 0.8, 160), behavior: 'smooth' })
  }
  const menuAction = (key: string, action: () => void | Promise<void>) => {
    const invokerId = menuState?.invokerId
    setMenuState(null)
    void run(key, action).finally(() => { if (invokerId) setTimeout(() => focusTab(invokerId), 0) })
  }
  const menuKeyDown = (event: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const current = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissMenu(true); return }
    let target: number | undefined
    if (event.key === 'ArrowDown') target = (current + 1) % items.length
    if (event.key === 'ArrowUp') target = (current - 1 + items.length) % items.length
    if (event.key === 'Home') target = 0
    if (event.key === 'End') target = items.length - 1
    if (target !== undefined) { event.preventDefault(); items[target]?.focus() }
  }
  useEffect(() => { if (menuState) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus() }, [menuState])
  useEffect(() => {
    const element = tablist.current
    if (!element) return
    syncScrollControls()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncScrollControls)
    observer.observe(element)
    return () => observer.disconnect()
  }, [props.tabs.length])
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setMenuState(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') dismissMenu(true) }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [])
  const showTabScrollControls = tabScrollState.canLeft || tabScrollState.canRight
  return (
    <div className="tabs-bar" ref={root}>
      {showTabScrollControls && <button type="button" className="tab-scroll-button" aria-label={copy.scrollTabsLeft} disabled={!tabScrollState.canLeft} onClick={() => scrollTabs(-1)}>◀</button>}
      <div className="file-tabs" role="tablist" aria-label={copy.openFiles} ref={tablist} onScroll={syncScrollControls}>
        {props.tabs.map((tab, index) => (
          <div key={tab.id} className={`file-tab-wrap ${tab.id === props.activeTabId ? 'active' : ''} ${tab.status}`}>
            <button role="tab" tabIndex={tab.id === props.activeTabId ? 0 : -1} aria-selected={tab.id === props.activeTabId}
              aria-label={tab.metadata?.name ?? tab.path.split(/[\\/]/).pop()} title={`${tab.path}${size(tab) ? ` · ${size(tab)}` : ''}`}
              data-tab-id={tab.id} className="file-tab" onClick={() => props.onActivate(tab.id)} onKeyDown={(event) => keyDown(event, tab, index)}
              onAuxClick={(event) => { if (event.button === 1) void run('Close file', () => props.onClose(tab.id)) }}
              onContextMenu={(event) => { event.preventDefault(); openMenu(tab, event.currentTarget, event.clientX, event.clientY) }}>
              <span className="status-dot" aria-hidden="true" /><span className="tab-name">{tab.metadata?.name ?? tab.path.split(/[\\/]/).pop()}</span>
            </button>
            <button className="tab-close" aria-label={copy.closeTab(tab.metadata?.name ?? tab.path)} onClick={() => void run('Close file', () => props.onClose(tab.id))}>×</button>
          </div>
        ))}
      </div>
      {showTabScrollControls && <button type="button" className="tab-scroll-button" aria-label={copy.scrollTabsRight} disabled={!tabScrollState.canRight} onClick={() => scrollTabs(1)}>▶</button>}
      {menuState && <div role="menu" className="tab-menu" ref={menu} style={{ left: menuState.x, top: menuState.y }} onKeyDown={menuKeyDown}>
        <button role="menuitem" onClick={() => menuAction('Close file', () => props.onClose(menuState.tab.id))}>{copy.closeFile}</button>
        <button role="menuitem" onClick={() => menuAction('Close files', () => props.onCloseOthers(menuState.tab.id))}>{copy.closeOtherTabs}</button>
        <button role="menuitem" onClick={() => menuAction('Close files', () => props.onCloseRight(menuState.tab.id))}>{copy.closeTabsToRight}</button>
        <button role="menuitem" onClick={() => menuAction('Copy path', async () => { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(menuState.tab.path) })}>{copy.copyPath}</button>
        <button role="menuitem" onClick={() => menuAction('Reveal file', () => props.onReveal(menuState.tab.path))}>{copy.revealInFileManager}</button>
      </div>}
    </div>
  )
}
