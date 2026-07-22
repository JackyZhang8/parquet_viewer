import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { DropZone } from '../features/open/DropZone'
import { FileTabs } from '../features/tabs/FileTabs'
import { AppliedFilterChips, FilterBar } from '../features/query/FilterBar'
import { SettingsDialog } from '../features/settings/SettingsDialog'
import { desktopApi, type DesktopApi } from '../lib/tauri'
import { createWorkspaceStore, type WorkspaceState } from '../stores/workspace'
import { isAppError, type AppSettings, type ExportProgress, type ExportSource, type FilterCondition, type SessionFilter } from '../domain/types'
import type { StoreApi } from 'zustand/vanilla'
import { QueryResultPane } from './QueryResultPane'
import { StatsPanel } from '../features/stats/StatsPanel'
import { AboutDialog } from '../features/about/AboutDialog'
import { labelsFor } from './labels'
import { buildFilterQueryRequest } from '../features/query/filterSql'
import './app.css'

const SqlEditor = lazy(() => import('../features/query/SqlEditor').then((module) => ({ default: module.SqlEditor })))

interface AppProps { api?: DesktopApi; store?: StoreApi<WorkspaceState> }

const defaultSettings: AppSettings = { language: 'en', theme: 'system', batchSize: 500, previewLimit: 10_000, memoryLimitMb: 512,
  tempDirectory: null, tempDiskWarningMb: 1024, concurrency: 2, restoreTabs: true }
const noHiddenColumns = new Set<string>()
const MIN_PROGRESS_DISPLAY_MS = 200
const asSessionFilter = (filter: FilterCondition): SessionFilter => {
  if ('value' in filter && filter.value !== undefined) {
    return { column: filter.column, operator: filter.operator, value: filter.value }
  }
  return { column: filter.column, operator: filter.operator, value: { type: 'null' } }
}

export function App({ api = desktopApi, store: suppliedStore }: AppProps) {
  const store = useMemo(() => suppliedStore ?? createWorkspaceStore(api), [api, suppliedStore])
  const state = useStore(store)
  const [exportsByTab, setExportsByTab] = useState<Record<string, ExportProgress>>({})
  const [exportTotalsByTab, setExportTotalsByTab] = useState<Record<string, string>>({})
  const [exportPreparationByTab, setExportPreparationByTab] = useState<Record<string, boolean>>({})
  const exportOwners = useRef(new Map<string, string>())
  const pendingExportProgress = useRef(new Map<string, ExportProgress>())
  const settingsSaveQueue = useRef(Promise.resolve())
  const latestSettingsSave = useRef(0)
  const [settings, setSettings] = useState(defaultSettings)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [statisticsOpen, setStatisticsOpen] = useState(false)
  const [externalChangeTabId, setExternalChangeTabId] = useState<string | null>(null)
  const [pendingClose, setPendingClose] = useState<{ count: number; action: () => Promise<void> } | null>(null)
  const [queryPanelsByTab, setQueryPanelsByTab] = useState<Record<string, 'filter' | 'sql' | null>>({})
  const [hiddenColumnsByTab, setHiddenColumnsByTab] = useState<Record<string, Set<string>>>({})
  const [loadingOperations, setLoadingOperations] = useState<{ id: number; message: string }[]>([])
  const ignoredExternalChanges = useRef(new Set<string>())
  const pendingQueryReplays = useRef(new Set<string>())
  const nextLoadingOperation = useRef(0)
  const copy = labelsFor(settings.language)
  const beginLoadingOperation = (message: string) => {
    const id = ++nextLoadingOperation.current
    const startedAt = Date.now()
    setLoadingOperations((current) => [...current, { id, message }])
    return () => {
      const remaining = Math.max(0, MIN_PROGRESS_DISPLAY_MS - (Date.now() - startedAt))
      window.setTimeout(() => setLoadingOperations((current) => current.filter((operation) => operation.id !== id)), remaining)
    }
  }
  const withLoadingOperation = async <T,>(message: string, action: () => Promise<T>) => {
    const finish = beginLoadingOperation(message)
    try { return await action() } finally { finish() }
  }
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    let unlistenExport: (() => void) | undefined
    store.getState().resume()
    api.loadSettings().then((loaded) => {
      if (disposed) return
      setSettings(loaded)
      document.documentElement.dataset.theme = loaded.theme
      setSettingsLoaded(true)
      return store.getState().hydrate(loaded.restoreTabs)
    }).catch((error) => {
      store.getState().reportError('Settings', error)
      if (!disposed) setSettingsLoaded(true)
      return store.getState().hydrate()
    }).catch((error) => store.getState().reportError('Session restore', error))
    api.onFileDrop((paths) => {
      withLoadingOperation(copy.openingFilesProgress, () => store.getState().openPaths(paths))
        .catch((error) => store.getState().reportError('File drop', error))
    }).then((cleanup) => {
      if (disposed) cleanup(); else unlisten = cleanup
    }).catch((error) => store.getState().reportError('File drop', error))
    api.onExportProgress((progress) => {
      const owner = exportOwners.current.get(progress.exportId)
      if (!owner) {
        pendingExportProgress.current.set(progress.exportId, progress)
        return
      }
      setExportsByTab((current) => current[owner]?.exportId === progress.exportId
        ? { ...current, [owner]: progress }
        : current)
      if (['completed', 'cancelled', 'error'].includes(progress.status)) exportOwners.current.delete(progress.exportId)
    }).then((cleanup) => { if (disposed) cleanup(); else unlistenExport = cleanup })
      .catch((error) => store.getState().reportError('Export events', error))
    return () => {
      disposed = true; unlisten?.(); unlistenExport?.(); exportOwners.current.clear(); pendingExportProgress.current.clear(); store.getState().dispose()
    }
  }, [api, store, suppliedStore])
  useEffect(() => {
    let disposed = false
    let checking = false
    const checkForExternalChanges = async () => {
      if (checking) return
      checking = true
      try {
        for (const tab of store.getState().tabs) {
          if (tab.status !== 'ready' || ignoredExternalChanges.current.has(tab.fileId)) continue
          if (await api.isFileChanged(tab.fileId)) {
            if (!disposed) setExternalChangeTabId((current) => current ?? tab.id)
            return
          }
        }
      } finally { checking = false }
    }
    const timer = window.setInterval(() => { void checkForExternalChanges() }, 2_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [api, store])
  const active = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
  const loadingOperation = loadingOperations.at(-1)
  const externalChangeTab = externalChangeTabId ? state.tabs.find((tab) => tab.id === externalChangeTabId) : undefined
  const activeQuery = active ? state.queriesByTab[active.id] : undefined
  const queryPanel = active ? queryPanelsByTab[active.id] ?? null : null
  const panelKey = active ? encodeURIComponent(active.id) : 'none'
  const filterPanelId = `filter-panel-${panelKey}`
  const sqlPanelId = `sql-panel-${panelKey}`
  const hiddenColumnNames = active ? hiddenColumnsByTab[active.id] ?? noHiddenColumns : noHiddenColumns
  const updateHiddenColumnNames = (next: Set<string>) => {
    if (!active) return
    setHiddenColumnsByTab((current) => ({ ...current, [active.id]: next }))
  }
  const toggleQueryPanel = (panel: 'filter' | 'sql') => {
    if (!active) return
    setQueryPanelsByTab((current) => ({ ...current, [active.id]: current[active.id] === panel ? null : panel }))
  }
  const appliedFilters = activeQuery?.source === 'filter' && activeQuery.hasSuccessfulResult && !activeQuery.stale && activeQuery.submittedFilter
    ? activeQuery.submittedFilter.filters.map(asSessionFilter) : []
  const rerunAppliedFilters = (filters: SessionFilter[]) => {
    if (!active?.metadata || !activeQuery?.submittedFilter) return
    try {
      const request = buildFilterQueryRequest(active.metadata.columns, filters, [], activeQuery.submittedFilter.previewLimit)
      state.setFilters(active.id, filters)
      void state.runFilterQuery(active.id, request, settings.batchSize)
    } catch (error) { state.reportError('Filters', error) }
  }
  const refreshQuery = (tabId = active?.id) => {
    if (!tabId) return
    const query = state.queriesByTab[tabId]
    const sql = query?.source === 'sql' ? query.submittedSql : undefined
    const filter = query?.source === 'filter' ? query.submittedFilter : undefined
    if (sql) {
      void withLoadingOperation(copy.refreshingData, () => state.runSqlQuery(tabId, sql, settings.previewLimit, settings.batchSize))
    } else if (filter) {
      void withLoadingOperation(copy.refreshingData, () => state.runFilterQuery(tabId, filter, settings.batchSize))
    }
  }
  const keepExternalFileVersion = () => {
    if (externalChangeTab) ignoredExternalChanges.current.add(externalChangeTab.fileId)
    setExternalChangeTabId(null)
  }
  const reloadExternallyChangedFile = async () => {
    if (!externalChangeTab) return
    const workspace = store.getState()
    const tab = workspace.tabs.find((item) => item.id === externalChangeTab.id)
    const query = tab ? workspace.queriesByTab[tab.id] : undefined
    if (!tab) { setExternalChangeTabId(null); return }
    const shouldReplayQuery = Boolean(query?.source === 'sql' && query.submittedSql || query?.source === 'filter' && query.submittedFilter)
    if (shouldReplayQuery) pendingQueryReplays.current.add(tab.id)
    try {
      await withLoadingOperation(copy.reloadingFile, async () => {
        await workspace.reloadTab(tab.id)
        ignoredExternalChanges.current.delete(tab.fileId)
        setExternalChangeTabId(null)
        if (query?.source === 'sql' && query.submittedSql) {
          await store.getState().runSqlQuery(tab.id, query.submittedSql, settings.previewLimit, settings.batchSize)
        } else if (query?.source === 'filter' && query.submittedFilter) {
          await store.getState().runFilterQuery(tab.id, query.submittedFilter, settings.batchSize)
        }
        pendingQueryReplays.current.delete(tab.id)
      })
    } catch (error) {
      pendingQueryReplays.current.delete(tab.id)
      store.getState().reportError('Reload changed file', error)
    }
  }
  const sqlDraftError = activeQuery?.source === 'sql' && activeQuery.status === 'error' && activeQuery.submittedSql === active?.sqlDraft
    ? activeQuery.error : undefined
  useEffect(() => {
    if (!settingsLoaded || active?.status !== 'ready' || !active.metadata || activeQuery || pendingQueryReplays.current.has(active.id)) return
    void state.runFilterQuery(active.id, {
      selectedColumns: [], filters: [], sorts: [], previewLimit: settings.previewLimit,
    }, settings.batchSize)
  }, [active, activeQuery, settings.batchSize, settings.previewLimit, settingsLoaded, state.runFilterQuery])
  useEffect(() => {
    document.documentElement.lang = settings.language === 'zh' ? 'zh-CN' : 'en'
  }, [settings.language])
  const exportResult = async () => {
    if (!active?.metadata) return
    if (exportPreparationByTab[active.id]) return
    const query = state.queriesByTab[active.id]
    if (!query?.hasSuccessfulResult || query.stale) return
    let source: ExportSource | undefined
    if (query.source === 'sql' && query.submittedSql) source = { kind: 'sql', sql: query.submittedSql }
    if (query.source === 'filter' && query.submittedFilter) source = { kind: 'filter', query: query.submittedFilter }
    if (!source) return
    setExportPreparationByTab((current) => ({ ...current, [active.id]: true }))
    try {
      const inspection = await api.inspectExport({ fileId: active.fileId, source })
      if (inspection.requiresConfirmation && !(await api.confirmLargeExport(inspection.estimatedRows))) return
      const suggested = active.metadata.name.replace(/\.parquet$/i, '') + '.csv'
      const destination = await api.pickCsvDestination(suggested)
      if (!destination) return
      let overwrite = false
      let started
      try {
        started = await api.startExport({ fileId: active.fileId, destination, overwrite, source })
      } catch (error) {
        if (!isAppError(error) || error.code !== 'ALREADY_EXISTS' ||
            !(await api.confirmExportOverwrite(destination))) throw error
        overwrite = true
        started = await api.startExport({ fileId: active.fileId, destination, overwrite, source })
      }
      exportOwners.current.set(started.exportId, active.id)
      const earlyProgress = pendingExportProgress.current.get(started.exportId)
      pendingExportProgress.current.delete(started.exportId)
      setExportsByTab((current) => ({
        ...current,
        [active.id]: earlyProgress ?? { exportId: started.exportId, status: 'queued', rowsWritten: '0', error: null },
      }))
      setExportTotalsByTab((current) => ({ ...current, [active.id]: inspection.estimatedRows }))
      if (earlyProgress && ['completed', 'cancelled', 'error'].includes(earlyProgress.status)) {
        exportOwners.current.delete(started.exportId)
      }
    } catch (error) {
      store.getState().reportError('CSV export', error)
    } finally {
      setExportPreparationByTab((current) => ({ ...current, [active.id]: false }))
    }
  }
  const cancelExport = async () => {
    if (!active) return
    const progress = exportsByTab[active.id]
    if (!progress || !['queued', 'running'].includes(progress.status)) return
    try { await api.cancelExport(progress.exportId) } catch (error) { store.getState().reportError('Cancel export', error) }
  }
  const closeWithConfirmation = (count: number, action: () => Promise<void>) => {
    if (count === 0) { void action().catch((error) => state.reportError('Close files', error)); return }
    setPendingClose({ count, action })
  }
  const confirmPendingClose = async () => {
    const closing = pendingClose
    setPendingClose(null)
    if (!closing) return
    try { await closing.action() } catch (error) { state.reportError('Close files', error) }
  }
  const applySettings = (next: AppSettings) => {
    const version = ++latestSettingsSave.current
    setSettings(next)
    document.documentElement.dataset.theme = next.theme
    const save = settingsSaveQueue.current.then(() => api.saveSettings(next))
    settingsSaveQueue.current = save.then(() => undefined, () => undefined)
    return save.then((saved) => {
      if (version === latestSettingsSave.current) {
        setSettings(saved)
        document.documentElement.dataset.theme = saved.theme
      }
      return saved
    })
  }
  return (
    <main className="app-shell jetbrains-mono">
      <header className="titlebar"><span className="app-mark">P</span><strong>Parquet Viewer</strong><div className="titlebar-actions"><DropZone compact language={settings.language} pickFiles={api.pickParquetFiles} onOpen={(paths) => withLoadingOperation(copy.openingFilesProgress, () => state.openPaths(paths))} onError={state.reportError} />{active?.status === 'ready' && active.metadata && <><button type="button" className="query-toggle" aria-expanded={queryPanel === 'filter'} aria-controls={filterPanelId} onClick={() => toggleQueryPanel('filter')}>{copy.filter}</button><button type="button" className="query-toggle" aria-expanded={queryPanel === 'sql'} aria-controls={sqlPanelId} onClick={() => toggleQueryPanel('sql')}>{copy.sql}</button><button type="button" className="statistics-toggle" aria-expanded={statisticsOpen} aria-controls="file-statistics" onClick={() => setStatisticsOpen((open) => !open)}>{copy.statistics}</button></>}<button type="button" className="about-button" onClick={() => setAboutOpen(true)}>{copy.about}</button><button type="button" className="settings-button" onClick={() => setSettingsOpen(true)}>{copy.settings}</button></div></header>
      {loadingOperation && <div className="operation-progress" role="status" aria-live="polite"><span>{loadingOperation.message}</span><div className="operation-progress-bar" role="progressbar" aria-label={loadingOperation.message} /></div>}
      {state.warning && <div className="warning-banner" role="status">{state.warning}</div>}
      {Object.entries(state.pathErrors).map(([path, error]) => <div className="error-banner" role="alert" key={path}><strong>{path.split(/[\\/]/).pop()}</strong>: {error.message}</div>)}
      {state.tabs.length === 0 ? <div className="empty-workspace"><DropZone language={settings.language} pickFiles={api.pickParquetFiles} onOpen={(paths) => withLoadingOperation(copy.openingFilesProgress, () => state.openPaths(paths))} onError={state.reportError} />{state.opening > 0 && <p>{copy.openingFiles(state.opening)}</p>}</div> : <>
        <FileTabs tabs={state.tabs} activeTabId={state.activeTabId} onActivate={state.activateTab}
          onClose={(id) => closeWithConfirmation(1, () => state.closeTab(id))}
          onCloseOthers={(id) => closeWithConfirmation(state.tabs.filter((tab) => tab.id !== id).length, () => state.closeOthers(id))}
          onCloseRight={(id) => {
            const index = state.tabs.findIndex((tab) => tab.id === id)
            return closeWithConfirmation(index < 0 ? 0 : state.tabs.length - index - 1, () => state.closeRight(id))
          }}
          onReveal={api.revealItemInDir} onError={state.reportError} language={settings.language} />
        {active?.status === 'ready' && active.metadata ? <section className="workspace-main">
          {queryPanel === 'filter' && <div id={filterPanelId} className="query-panel query-panel-filter">
            <FilterBar key={`filter-${active.id}`} columns={active.metadata.columns} filters={active.filters}
              initialPreviewLimit={settings.previewLimit} language={settings.language}
              onFiltersChange={(filters) => state.setFilters(active.id, filters)}
              onRun={(request) => void state.runFilterQuery(active.id, request, settings.batchSize)} />
          </div>}
          {queryPanel === 'sql' && <div id={sqlPanelId} className="query-panel query-panel-sql">
            <Suspense fallback={<div className="sql-editor-shell sql-editor-loading" style={{ height: active.viewState.editorHeight }}
              role="status" aria-live="polite" aria-busy="true">
              <strong>{copy.loadingSqlEditor}</strong>
              <div className="sql-editor-loading-bar" role="progressbar" aria-label={copy.loadingSqlEditor} />
            </div>}>
              <SqlEditor key={`sql-${active.id}`} tabId={active.id} fileId={active.fileId} value={active.sqlDraft}
                columns={active.metadata.columns} height={active.viewState.editorHeight} error={sqlDraftError}
                initialPreviewLimit={settings.previewLimit} language={settings.language} theme={settings.theme}
                onChange={(sqlDraft) => state.setSqlDraft(active.id, sqlDraft)}
                onRun={(previewLimit) => void state.runSqlQuery(active.id, active.sqlDraft, previewLimit, settings.batchSize)}
                onHeightChange={(editorHeight) => state.setViewState(active.id, { editorHeight })} />
            </Suspense>
          </div>}
          {queryPanel !== 'filter' && <AppliedFilterChips filters={appliedFilters} language={settings.language}
            onRemove={(index) => rerunAppliedFilters(appliedFilters.filter((_, current) => current !== index))}
            onClear={() => rerunAppliedFilters([])} />}
          <QueryResultPane key={`result-${active.id}`} query={state.queriesByTab[active.id]}
            initialScroll={{ top: active.viewState.scrollTop, left: active.viewState.scrollLeft }}
            onScrollChange={({ top: scrollTop, left: scrollLeft }) => state.setViewState(active.id, { scrollTop, scrollLeft })}
            onLoadMore={() => void state.loadNextBatch(active.id)} onRefresh={() => refreshQuery()} onCancel={() => void state.cancelQuery(active.id)}
            exportProgress={exportsByTab[active.id]} exportTotalRows={exportTotalsByTab[active.id]}
            exportPreparing={Boolean(exportPreparationByTab[active.id])}
            onExport={() => void exportResult()} onCancelExport={() => void cancelExport()}
            hiddenColumnNames={hiddenColumnNames} onHiddenColumnNamesChange={updateHiddenColumnNames} language={settings.language} />
          {statisticsOpen && <StatsPanel id="file-statistics" metadata={active.metadata}
            onClose={() => setStatisticsOpen(false)} language={settings.language} />}
        </section> : <section className="workspace-placeholder"><div className="opened-file-card"><span className={`opened-status ${active?.status}`} aria-hidden="true" /><div><strong>{active?.status === 'loading' ? 'Loading file…' : active?.status === 'unavailable' ? 'File unavailable' : 'Could not open file'}</strong><p>{active?.path}</p><span className="file-state">{active?.status}</span>{active?.status !== 'loading' && <button onClick={() => void withLoadingOperation(copy.openingFilesProgress, () => state.openPaths([active.path]))}>Retry</button>}</div></div></section>}
      </>}
      {aboutOpen && <AboutDialog language={settings.language} onClose={() => setAboutOpen(false)} />}
      {externalChangeTab && <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) keepExternalFileVersion() }}>
        <section className="external-change-dialog" role="dialog" aria-modal="true" aria-label={copy.externalFileChangedTitle}>
          <header><strong>{copy.externalFileChangedTitle}</strong><button type="button" aria-label={copy.keepCurrentVersion} onClick={keepExternalFileVersion}>×</button></header>
          <p>{copy.externalFileChangedMessage(externalChangeTab.metadata?.name ?? externalChangeTab.path.split(/[\\/]/).pop() ?? externalChangeTab.path)}</p>
          <footer><button type="button" onClick={keepExternalFileVersion}>{copy.keepCurrentVersion}</button><button type="button" className="primary-button" onClick={() => void reloadExternallyChangedFile()}>{copy.reloadFile}</button></footer>
        </section>
      </div>}
      {pendingClose && <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingClose(null) }}>
        <section className="close-tabs-dialog" role="dialog" aria-modal="true" aria-label={copy.closeTabsDialog}>
          <header><strong>{copy.closeTabsDialog}</strong><button type="button" aria-label={copy.cancel} onClick={() => setPendingClose(null)}>×</button></header>
          <p>{copy.closeTabsMessage(pendingClose.count)}</p>
          <footer><button type="button" onClick={() => setPendingClose(null)}>{copy.cancel}</button><button type="button" className="primary-button" onClick={() => void confirmPendingClose()}>{copy.closeTabsAction(pendingClose.count)}</button></footer>
        </section>
      </div>}
      {settingsOpen && <SettingsDialog settings={settings} language={settings.language} onChange={applySettings} pickDirectory={api.pickDirectory} onClose={() => setSettingsOpen(false)} />}
    </main>
  )
}
