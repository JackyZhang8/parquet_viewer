import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { DropZone } from '../features/open/DropZone'
import { FileTabs } from '../features/tabs/FileTabs'
import { FilterBar } from '../features/query/FilterBar'
import { SchemaPanel } from '../features/schema/SchemaPanel'
import { desktopApi, type DesktopApi } from '../lib/tauri'
import { createWorkspaceStore, type WorkspaceState } from '../stores/workspace'
import type { FilterQueryRequest } from '../domain/types'
import type { StoreApi } from 'zustand/vanilla'
import './app.css'

interface AppProps { api?: DesktopApi; store?: StoreApi<WorkspaceState>; onRun?: (request: FilterQueryRequest) => void }

export function App({ api = desktopApi, store: suppliedStore, onRun = () => undefined }: AppProps) {
  const store = useMemo(() => suppliedStore ?? createWorkspaceStore(api), [api, suppliedStore])
  const state = useStore(store)
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    store.getState().resume()
    store.getState().hydrate().catch((error) => store.getState().reportError('Session restore', error))
    api.onFileDrop((paths) => {
      store.getState().openPaths(paths).catch((error) => store.getState().reportError('File drop', error))
    }).then((cleanup) => {
      if (disposed) cleanup(); else unlisten = cleanup
    }).catch((error) => store.getState().reportError('File drop', error))
    return () => { disposed = true; unlisten?.(); store.getState().dispose() }
  }, [api, store, suppliedStore])
  const active = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
  return (
    <main className="app-shell">
      <header className="titlebar"><span className="app-mark">P</span><strong>Parquet Viewer</strong><DropZone compact pickFiles={api.pickParquetFiles} onOpen={state.openPaths} onError={state.reportError} /></header>
      {state.warning && <div className="warning-banner" role="status">{state.warning}</div>}
      {Object.entries(state.pathErrors).map(([path, error]) => <div className="error-banner" role="alert" key={path}><strong>{path.split(/[\\/]/).pop()}</strong>: {error.message}</div>)}
      {state.tabs.length === 0 ? <div className="empty-workspace"><DropZone pickFiles={api.pickParquetFiles} onOpen={state.openPaths} onError={state.reportError} />{state.opening > 0 && <p>Opening {state.opening} file(s)…</p>}</div> : <>
        <FileTabs tabs={state.tabs} activeTabId={state.activeTabId} onActivate={state.activateTab} onClose={state.closeTab} onCloseOthers={state.closeOthers} onCloseRight={state.closeRight} onReveal={api.revealItemInDir} onError={state.reportError} />
        {active?.status === 'ready' && active.metadata ? <section className="workspace-main">
          <SchemaPanel key={active.id} metadata={active.metadata} width={active.viewState.sidebarWidth} onWidthChange={(sidebarWidth) => state.setViewState(active.id,{sidebarWidth})} onError={(error) => state.reportError('Clipboard',error)} />
          <div className="query-pane"><FilterBar key={active.id} columns={active.metadata.columns} filters={active.filters} sorts={active.sorts} onFiltersChange={(filters) => state.setFilters(active.id,filters)} onSortsChange={(sorts) => state.setSorts(active.id,sorts)} onRun={onRun} /><div className="result-placeholder"><strong>No query result</strong><p>Run filters to prepare a request. Results arrive in Task 9.</p></div></div>
        </section> : <section className="workspace-placeholder"><div className="opened-file-card"><span className={`opened-status ${active?.status}`} aria-hidden="true" /><div><strong>{active?.status === 'loading' ? 'Loading file…' : active?.status === 'unavailable' ? 'File unavailable' : 'Could not open file'}</strong><p>{active?.path}</p><span className="file-state">{active?.status}</span>{active?.status !== 'loading' && <button onClick={() => state.openPaths([active.path])}>Retry</button>}</div></div></section>}
      </>}
    </main>
  )
}
