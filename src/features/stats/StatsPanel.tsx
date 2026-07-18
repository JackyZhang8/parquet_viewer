import { labelsFor } from '../../app/labels'
import type { AppLanguage, FileMetadata } from '../../domain/types'

interface Props {
  id: string
  metadata: FileMetadata
  onClose(): void
  language?: AppLanguage
}

const formatCount = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const fileSizeUnits = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

const formatFileSize = (value: string) => {
  let bytes = Number(value)
  let unit = 0
  while (unit < fileSizeUnits.length - 1 && bytes >= 1024) {
    bytes /= 1024
    unit += 1
  }
  return unit === 0 ? `${Math.round(bytes)} B` : `${bytes.toFixed(1)} ${fileSizeUnits[unit]}`
}

export function StatsPanel({ id, metadata, onClose, language = 'en' }: Props) {
  const copy = labelsFor(language)

  return <aside id={id} className="stats-panel" aria-label={copy.fileStatistics}>
    <header><strong>{copy.statistics}</strong><button type="button" aria-label={copy.closeStatistics} onClick={onClose}>×</button></header>
    <div className="stats-file"><strong>{metadata.name}</strong><span title={metadata.path}>{metadata.path}</span></div>
    <dl className="stats-counters">
      <div><dt>{copy.rows}</dt><dd>{formatCount(metadata.rowCount)}</dd></div>
      <div><dt>{copy.columns}</dt><dd>{metadata.columns.length}</dd></div>
      <div><dt>{copy.rowGroups}</dt><dd>{metadata.rowGroupCount}</dd></div>
      <div><dt>{copy.fileSize}</dt><dd>{formatCount(metadata.sizeBytes)} {copy.bytes}<small>{formatFileSize(metadata.sizeBytes)}</small></dd></div>
    </dl>
  </aside>
}
