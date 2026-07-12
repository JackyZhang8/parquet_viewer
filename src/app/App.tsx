import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { DropZone } from '../features/open/DropZone'
import { FileTabs } from '../features/tabs/FileTabs'
import { desktopApi, type DesktopApi } from '../lib/tauri'
import { createWorkspaceStore, type WorkspaceState } from '../stores/workspace'
import type { StoreApi } from 'zustand/vanilla'
import './app.css'

interface AppProps { api?: DesktopApi; store?: StoreApi<WorkspaceState> }

export function App({ api = desktopApi, store: suppliedStore }: AppProps) {
  const store = useMemo(() => suppliedStore ?? createWorkspaceStore(api), [api, suppliedStore])
  const state = useStore(store)
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void store.getState().hydrate()
    void api.onFileDrop((paths) => void store.getState().openPaths(paths)).then((cleanup) => {
      if (disposed) cleanup(); else unlisten = cleanup
    })
    return () => { disposed = true; unlisten?.(); if (!suppliedStore) store.getState().dispose() }
  }, [api, store, suppliedStore])
  const active = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
  return (
    <main className="app-shell">
      <header className="titlebar"><span className="app-mark">P</span><strong>Parquet Viewer</strong><DropZone compact pickFiles={api.pickParquetFiles} onOpen={state.openPaths} /></header>
      {state.warning && <div className="warning-banner" role="status">{state.warning}</div>}
      {Object.entries(state.pathErrors).map(([path, error]) => <div className="error-banner" role="alert" key={path}><strong>{path.split(/[\\/]/).pop()}</strong>: {error.message}</div>)}
      {state.tabs.length === 0 ? <div className="empty-workspace"><DropZone pickFiles={api.pickParquetFiles} onOpen={state.openPaths} />{state.opening > 0 && <p>Opening {state.opening} file(s)…</p>}</div> : <>
        <FileTabs tabs={state.tabs} activeTabId={state.activeTabId} onActivate={state.activateTab} onClose={(id) => void state.closeTab(id)} onCloseOthers={(id) => void state.closeOthers(id)} onCloseRight={(id) => void state.closeRight(id)} onReveal={(path) => void api.revealItemInDir(path)} />
        <section className="workspace">
          <aside className="sidebar"><div className="panel-heading">File</div><div className="file-card"><strong>{active?.metadata?.name ?? active?.path}</strong><span>{active?.status}</span></div><div className="panel-heading">Schema</div><p className="placeholder-copy">Schema details arrive in the next workspace layer.</p></aside>
          <div className="main-pane"><section className="editor-placeholder"><div className="panel-heading">SQL workspace</div><textarea aria-label="SQL draft" value={active?.sqlDraft ?? ''} onChange={(event) => active && state.setSqlDraft(active.id, event.target.value)} placeholder="SQL editor coming next" /></section><section className="data-placeholder"><div className="panel-heading">Data</div><div className="placeholder-center"><strong>Data preview will appear here</strong><span>Choose filters or run a query in a later step.</span></div></section></div>
        </section>
      </>}
    </main>
  )
}
