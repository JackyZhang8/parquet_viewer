import { labelsFor } from '../../app/labels'
import type { AppLanguage } from '../../domain/types'

interface DropZoneProps {
  pickFiles(): Promise<string[] | null>
  onOpen(paths: string[]): void | Promise<void>
  onError?(key: string, error: unknown): void
  compact?: boolean
  language?: AppLanguage
}

export function DropZone({ pickFiles, onOpen, onError, compact = false, language = 'en' }: DropZoneProps) {
  const copy = labelsFor(language)
  const choose = async () => {
    try {
      const paths = await pickFiles()
      if (paths?.length) await onOpen(paths)
    } catch (error) { onError?.('File picker', error) }
  }
  if (compact) return <button className="open-button" onClick={() => void choose()}>{copy.openParquetFiles}</button>
  return (
    <section className="drop-zone" aria-label="File intake">
      <div className="drop-icon" aria-hidden="true">⇩</div>
      <h1>{copy.openParquetFiles}</h1>
      <p>{copy.dropFilesHint}</p>
      <button className="primary-button" onClick={() => void choose()}>{copy.openParquetFiles}</button>
    </section>
  )
}
