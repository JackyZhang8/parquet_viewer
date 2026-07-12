interface DropZoneProps {
  pickFiles(): Promise<string[] | null>
  onOpen(paths: string[]): void | Promise<void>
  compact?: boolean
}

export function DropZone({ pickFiles, onOpen, compact = false }: DropZoneProps) {
  const choose = async () => {
    const paths = await pickFiles()
    if (paths?.length) await onOpen(paths)
  }
  if (compact) return <button className="open-button" onClick={() => void choose()}>Open Parquet files</button>
  return (
    <section className="drop-zone" aria-label="File intake">
      <div className="drop-icon" aria-hidden="true">⇩</div>
      <h1>Open Parquet files</h1>
      <p>Drop one or more files anywhere in this window, or choose them from disk.</p>
      <button className="primary-button" onClick={() => void choose()}>Open Parquet files</button>
    </section>
  )
}
