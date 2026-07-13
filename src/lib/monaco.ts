import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() }
loader.config({ monaco })

export { monaco }
