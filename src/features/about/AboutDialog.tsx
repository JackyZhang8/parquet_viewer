import { labelsFor } from '../../app/labels'
import type { AppLanguage } from '../../domain/types'

const PROJECT_URL = 'https://github.com/JackyZhang8/parquet_viewer'

interface Props {
  language: AppLanguage
  onClose(): void
}

export function AboutDialog({ language, onClose }: Props) {
  const copy = labelsFor(language)
  return <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="about-dialog" role="dialog" aria-modal="true" aria-label={copy.aboutDialog}>
      <header><span className="app-mark" aria-hidden="true">P</span><div><strong>{copy.aboutDialog}</strong><span>{copy.aboutVersion}</span></div><button type="button" aria-label={copy.closeAbout} onClick={onClose}>×</button></header>
      <div className="about-content"><p className="about-eyebrow">{copy.aboutEyebrow}</p><h1>{copy.aboutHeadline}</h1><p className="about-lead">{copy.aboutDescription}</p><p className="about-details">{copy.aboutDetails}</p><dl className="about-project-info"><div><dt>{copy.aboutRepository}</dt><dd><a href={PROJECT_URL} target="_blank" rel="noreferrer">{PROJECT_URL}</a></dd></div><div><dt>{copy.aboutLicense}</dt><dd>Apache License 2.0</dd></div><div><dt>{copy.aboutAuthor}</dt><dd>JackyZhang</dd></div></dl></div>
      <footer><button type="button" onClick={onClose}>{copy.close}</button></footer>
    </section>
  </div>
}
