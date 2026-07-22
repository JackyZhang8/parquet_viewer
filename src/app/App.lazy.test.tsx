import { expect, it, vi } from 'vitest'

const sqlEditorModuleLoaded = vi.hoisted(() => vi.fn())

vi.mock('../features/query/SqlEditor', () => {
  sqlEditorModuleLoaded()
  return { SqlEditor: () => null }
})

import { App } from './App'

it('keeps the SQL editor module unloaded when the application module loads', () => {
  expect(App).toBeTypeOf('function')
  expect(sqlEditorModuleLoaded).not.toHaveBeenCalled()
})
