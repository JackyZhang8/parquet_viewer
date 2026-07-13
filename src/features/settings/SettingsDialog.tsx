import { useState } from 'react'

import type { AppSettings } from '../../domain/types'

interface Props {
  settings: AppSettings
  onSave(settings: AppSettings): Promise<AppSettings>
  pickDirectory(): Promise<string | null>
  onClose(): void
}

export function SettingsDialog({ settings, onSave, pickDirectory, onClose }: Props) {
  const [draft, setDraft] = useState(settings)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const numeric = (key: 'batchSize' | 'previewLimit' | 'memoryLimitMb' | 'tempDiskWarningMb', value: string) =>
    setDraft((current) => ({ ...current, [key]: Number(value) }))
  const save = async () => {
    setSaving(true); setError('')
    try { await onSave(draft); onClose() }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Settings could not be saved') }
    finally { setSaving(false) }
  }
  const chooseDirectory = async () => {
    try {
      const directory = await pickDirectory()
      if (directory) setDraft((current) => ({ ...current, tempDirectory: directory }))
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Directory could not be selected') }
  }

  return <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="Settings">
      <header><strong>Settings</strong><button type="button" aria-label="Close settings" onClick={onClose}>×</button></header>
      <div className="settings-fields">
        <label>Theme<select aria-label="Theme" value={draft.theme} onChange={(event) => setDraft({ ...draft, theme: event.target.value as AppSettings['theme'] })}>
          <option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option>
        </select></label>
        <label>Batch size<input aria-label="Batch size" type="number" min="50" max="5000" value={draft.batchSize} onChange={(event) => numeric('batchSize', event.target.value)} /></label>
        <label>Preview row limit<input aria-label="Preview row limit" type="number" min="100" max="100000" value={draft.previewLimit} onChange={(event) => numeric('previewLimit', event.target.value)} /></label>
        <label>Memory limit MB<input aria-label="Memory limit MB" type="number" min="64" max="16384" value={draft.memoryLimitMb} onChange={(event) => numeric('memoryLimitMb', event.target.value)} /></label>
        <label>Disk warning MB<input aria-label="Disk warning MB" type="number" min="64" max="102400" value={draft.tempDiskWarningMb} onChange={(event) => numeric('tempDiskWarningMb', event.target.value)} /></label>
        <label>Concurrent queries<select aria-label="Concurrent queries" value={draft.concurrency} onChange={(event) => setDraft({ ...draft, concurrency: Number(event.target.value) })}>
          {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label className="settings-wide">Temporary directory<input aria-label="Temporary directory" readOnly value={draft.tempDirectory ?? ''} placeholder="System temporary directory" /></label>
        <div className="settings-directory-actions"><button type="button" onClick={() => void chooseDirectory()}>Choose temporary directory</button>
          <button type="button" onClick={() => setDraft({ ...draft, tempDirectory: null })}>Use system temporary directory</button></div>
        <label className="settings-check"><input aria-label="Restore tabs on startup" type="checkbox" checked={draft.restoreTabs} onChange={(event) => setDraft({ ...draft, restoreTabs: event.target.checked })} /> Restore tabs on startup</label>
      </div>
      {error && <p role="alert" className="inline-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={saving} onClick={() => void save()}>Save settings</button></footer>
    </section>
  </div>
}
