import { useRef, useState } from 'react'

import { labelsFor } from '../../app/labels'
import type { AppSettings } from '../../domain/types'

interface Props {
  settings: AppSettings
  onChange(settings: AppSettings): Promise<AppSettings>
  pickDirectory(): Promise<string | null>
  onClose(): void
  language?: AppSettings['language']
}

type NumericKey = 'batchSize' | 'previewLimit' | 'memoryLimitMb' | 'tempDiskWarningMb'

const numericBounds: Record<NumericKey, readonly [number, number]> = {
  batchSize: [50, 5000], previewLimit: [100, 100000], memoryLimitMb: [64, 16384], tempDiskWarningMb: [64, 102400],
}

const numericValues = (settings: AppSettings): Record<NumericKey, string> => ({
  batchSize: String(settings.batchSize), previewLimit: String(settings.previewLimit), memoryLimitMb: String(settings.memoryLimitMb), tempDiskWarningMb: String(settings.tempDiskWarningMb),
})

export function SettingsDialog({ settings, onChange, pickDirectory, onClose, language = 'en' }: Props) {
  const copy = labelsFor(language)
  const [draft, setDraft] = useState(settings)
  const draftRef = useRef(settings)
  const changeVersion = useRef(0)
  const [numericDraft, setNumericDraft] = useState(() => numericValues(settings))
  const [error, setError] = useState('')
  const apply = (next: AppSettings) => {
    const version = ++changeVersion.current
    draftRef.current = next
    setDraft(next)
    setError('')
    void onChange(next).catch((caught) => {
      if (version === changeVersion.current) setError(caught instanceof Error ? caught.message : copy.settingsSaveFailed)
    })
  }
  const numeric = (key: NumericKey, value: string) => {
    setNumericDraft((current) => ({ ...current, [key]: value }))
    const parsed = Number(value)
    const [minimum, maximum] = numericBounds[key]
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return
    apply({ ...draftRef.current, [key]: parsed })
  }
  const chooseDirectory = async () => {
    try {
      const directory = await pickDirectory()
      if (directory) apply({ ...draftRef.current, tempDirectory: directory })
    } catch (caught) { setError(caught instanceof Error ? caught.message : copy.directorySelectFailed) }
  }

  return <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-label={copy.settings}>
      <header><strong>{copy.settings}</strong><button type="button" aria-label={copy.closeSettings} onClick={onClose}>×</button></header>
      <div className="settings-fields">
        <label>{copy.language}<select aria-label={copy.language} value={draft.language} onChange={(event) => apply({ ...draftRef.current, language: event.target.value as AppSettings['language'] })}>
          <option value="en">English</option><option value="zh">中文</option>
        </select></label>
        <label>{copy.theme}<select aria-label={copy.theme} value={draft.theme} onChange={(event) => apply({ ...draftRef.current, theme: event.target.value as AppSettings['theme'] })}>
          <option value="system">{copy.followSystem}</option><option value="light">{copy.light}</option><option value="dark">{copy.dark}</option>
        </select></label>
        <label>{copy.batchSize}<input aria-label={copy.batchSize} type="number" min="50" max="5000" value={numericDraft.batchSize} onChange={(event) => numeric('batchSize', event.target.value)} /></label>
        <label>{copy.previewRowLimit}<input aria-label={copy.previewRowLimit} type="number" min="100" max="100000" value={numericDraft.previewLimit} onChange={(event) => numeric('previewLimit', event.target.value)} /></label>
        <label>{copy.memoryLimitMb}<input aria-label={copy.memoryLimitMb} type="number" min="64" max="16384" value={numericDraft.memoryLimitMb} onChange={(event) => numeric('memoryLimitMb', event.target.value)} /></label>
        <label>{copy.diskWarningMb}<input aria-label={copy.diskWarningMb} type="number" min="64" max="102400" value={numericDraft.tempDiskWarningMb} onChange={(event) => numeric('tempDiskWarningMb', event.target.value)} /></label>
        <label>{copy.concurrentQueries}<select aria-label={copy.concurrentQueries} value={draft.concurrency} onChange={(event) => apply({ ...draftRef.current, concurrency: Number(event.target.value) })}>
          {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label className="settings-wide">{copy.temporaryDirectory}<input aria-label={copy.temporaryDirectory} readOnly value={draft.tempDirectory ?? ''} placeholder={copy.systemTemporaryDirectory} /></label>
        <div className="settings-directory-actions"><button type="button" onClick={() => void chooseDirectory()}>{copy.chooseTemporaryDirectory}</button>
          <button type="button" onClick={() => apply({ ...draftRef.current, tempDirectory: null })}>{copy.useSystemTemporaryDirectory}</button></div>
        <label className="settings-check"><input className="settings-check-input" aria-label={copy.restoreTabsOnStartup} type="checkbox" checked={draft.restoreTabs} onChange={(event) => apply({ ...draftRef.current, restoreTabs: event.target.checked })} /><span className="settings-check-box" aria-hidden="true" /><span>{copy.restoreTabsOnStartup}</span></label>
      </div>
      {error && <p role="alert" className="inline-error">{error}</p>}
      <footer><button type="button" onClick={onClose}>{copy.close}</button></footer>
    </section>
  </div>
}
