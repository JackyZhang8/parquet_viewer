import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { DropZone } from '../features/open/DropZone'
import { FileTabs } from '../features/tabs/FileTabs'
import { FilterBar } from '../features/query/FilterBar'
import { SqlEditor } from '../features/query/SqlEditor'
import { SchemaPanel } from '../features/schema/SchemaPanel'
import { desktopApi, type DesktopApi } from '../lib/tauri'
import { createWorkspaceStore, type WorkspaceState } from '../stores/workspace'
import type { FilterQueryRequest } from '../domain/types'
import type { StoreApi } from 'zustand/vanilla'
import { QueryResultPane } from './QueryResultPane'
import './app.css'

interface AppProps { api?: DesktopApi; store?: StoreApi<WorkspaceState>; onRun?: (request: FilterQueryRequest) => void }

export function App({ api = desktopApi, store: suppliedStore, onRun }: AppProps) {
  const store = useMemo(() => suppliedStore ?? createWorkspaceStore(api), [api, suppliedStore])
  const state = useStore(store)
  const [queryModes, setQueryModes] = useState<Record<string, 'filter' | 'sql'>>({})
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
  const queryMode = active ? queryModes[active.id] ?? 'filter' : 'filter'
  const modeKey = active ? encodeURIComponent(active.id) : 'none'
  const modeIds = {
    filterTab: `filter-tab-${modeKey}`, sqlTab: `sql-tab-${modeKey}`,
    filterPanel: `filter-panel-${modeKey}`, sqlPanel: `sql-panel-${modeKey}`,
  }
  const selectQueryMode = (mode: 'filter' | 'sql', focus = false) => {
    if (!active) return
    setQueryModes((modes) => ({ ...modes, [active.id]: mode }))
    if (focus) document.getElementById(mode === 'filter' ? modeIds.filterTab : modeIds.sqlTab)?.focus()
  }
  const modeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, mode: 'filter' | 'sql') => {
    let next: 'filter' | 'sql' | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = mode === 'filter' ? 'sql' : 'filter'
    else if (event.key === 'Home') next = 'filter'
    else if (event.key === 'End') next = 'sql'
    if (next) { event.preventDefault(); selectQueryMode(next, true) }
  }
  return (
    <main className="app-shell">
      <header className="titlebar"><span className="app-mark">P</span><strong>Parquet Viewer</strong><DropZone compact pickFiles={api.pickParquetFiles} onOpen={state.openPaths} onError={state.reportError} /></header>
      {state.warning && <div className="warning-banner" role="status">{state.warning}</div>}
      {Object.entries(state.pathErrors).map(([path, error]) => <div className="error-banner" role="alert" key={path}><strong>{path.split(/[\\/]/).pop()}</strong>: {error.message}</div>)}
      {state.tabs.length === 0 ? <div className="empty-workspace"><DropZone pickFiles={api.pickParquetFiles} onOpen={state.openPaths} onError={state.reportError} />{state.opening > 0 && <p>Opening {state.opening} file(s)…</p>}</div> : <>
        <FileTabs tabs={state.tabs} activeTabId={state.activeTabId} onActivate={state.activateTab} onClose={state.closeTab} onCloseOthers={state.closeOthers} onCloseRight={state.closeRight} onReveal={api.revealItemInDir} onError={state.reportError} />
        {active?.status === 'ready' && active.metadata ? <section className="workspace-main">
          <SchemaPanel key={active.id} metadata={active.metadata} width={active.viewState.sidebarWidth} onWidthChange={(sidebarWidth) => state.setViewState(active.id,{sidebarWidth})} onError={(error) => state.reportError('Clipboard',error)} />
          <div className="query-pane">
            <div className="query-mode-tabs" role="tablist" aria-label="Query mode">
              <button id={modeIds.filterTab} type="button" role="tab" aria-selected={queryMode === 'filter'} aria-controls={modeIds.filterPanel}
                tabIndex={queryMode === 'filter' ? 0 : -1} onKeyDown={(event) => modeKeyDown(event, 'filter')} onClick={() => selectQueryMode('filter')}>Filter</button>
              <button id={modeIds.sqlTab} type="button" role="tab" aria-selected={queryMode === 'sql'} aria-controls={modeIds.sqlPanel}
                tabIndex={queryMode === 'sql' ? 0 : -1} onKeyDown={(event) => modeKeyDown(event, 'sql')} onClick={() => selectQueryMode('sql')}>SQL</button>
            </div>
            {queryMode === 'filter' ? <div id={modeIds.filterPanel} role="tabpanel" aria-labelledby={modeIds.filterTab}>
              <FilterBar key={active.id} columns={active.metadata.columns} filters={active.filters} sorts={active.sorts} onFiltersChange={(filters) => state.setFilters(active.id,filters)} onSortsChange={(sorts) => state.setSorts(active.id,sorts)} onRun={(request) => { onRun?.(request); void state.runFilterQuery(active.id, request) }} />
            </div> : <div id={modeIds.sqlPanel} role="tabpanel" aria-labelledby={modeIds.sqlTab} className="sql-tabpanel">
              <SqlEditor key={active.id} tabId={active.id} fileId={active.fileId} value={active.sqlDraft} columns={active.metadata.columns}
                height={active.viewState.editorHeight} error={state.queriesByTab[active.id]?.source === 'sql' && state.queriesByTab[active.id]?.status === 'error' && state.queriesByTab[active.id]?.submittedSql === active.sqlDraft ? state.queriesByTab[active.id]?.error : undefined}
                onChange={(sqlDraft) => state.setSqlDraft(active.id, sqlDraft)} onRun={(previewLimit) => void state.runSqlQuery(active.id, active.sqlDraft, previewLimit)}
                onHeightChange={(editorHeight) => state.setViewState(active.id, { editorHeight })} />
            </div>}
            <QueryResultPane key={`result-${active.id}`} query={state.queriesByTab[active.id]}
              initialScroll={{ top: active.viewState.scrollTop, left: active.viewState.scrollLeft }}
              onScrollChange={({ top: scrollTop, left: scrollLeft }) => state.setViewState(active.id, { scrollTop, scrollLeft })}
              onLoadMore={() => void state.loadNextBatch(active.id)} onCancel={() => void state.cancelQuery(active.id)} />
          </div>
        </section> : <section className="workspace-placeholder"><div className="opened-file-card"><span className={`opened-status ${active?.status}`} aria-hidden="true" /><div><strong>{active?.status === 'loading' ? 'Loading file…' : active?.status === 'unavailable' ? 'File unavailable' : 'Could not open file'}</strong><p>{active?.path}</p><span className="file-state">{active?.status}</span>{active?.status !== 'loading' && <button onClick={() => state.openPaths([active.path])}>Retry</button>}</div></div></section>}
      </>}
    </main>
  )
}
