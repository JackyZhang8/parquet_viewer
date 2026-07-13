import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import { SettingsDialog } from './SettingsDialog'

const settings = {
  theme: 'system' as const,
  batchSize: 500,
  previewLimit: 10_000,
  memoryLimitMb: 512,
  tempDirectory: null,
  tempDiskWarningMb: 1024,
  concurrency: 2,
  restoreTabs: true,
}

it('edits and saves every stability setting', async () => {
  const onSave = vi.fn(async (value) => value)
  render(<SettingsDialog settings={settings} onSave={onSave} onClose={() => undefined} pickDirectory={async () => null} />)

  await userEvent.selectOptions(screen.getByLabelText('Theme'), 'dark')
  await userEvent.clear(screen.getByLabelText('Batch size')); await userEvent.type(screen.getByLabelText('Batch size'), '750')
  await userEvent.clear(screen.getByLabelText('Preview row limit')); await userEvent.type(screen.getByLabelText('Preview row limit'), '25000')
  await userEvent.clear(screen.getByLabelText('Memory limit MB')); await userEvent.type(screen.getByLabelText('Memory limit MB'), '900')
  await userEvent.clear(screen.getByLabelText('Disk warning MB')); await userEvent.type(screen.getByLabelText('Disk warning MB'), '2048')
  await userEvent.selectOptions(screen.getByLabelText('Concurrent queries'), '3')
  await userEvent.click(screen.getByLabelText('Restore tabs on startup'))
  await userEvent.click(screen.getByRole('button', { name: 'Save settings' }))

  expect(onSave).toHaveBeenCalledWith({ ...settings, theme: 'dark', batchSize: 750, previewLimit: 25000,
    memoryLimitMb: 900, tempDiskWarningMb: 2048, concurrency: 3, restoreTabs: false })
})

it('selects and clears a temporary directory', async () => {
  const onSave = vi.fn(async (value) => value)
  render(<SettingsDialog settings={settings} onSave={onSave} onClose={() => undefined} pickDirectory={async () => '/tmp/parquet'} />)
  await userEvent.click(screen.getByRole('button', { name: /choose temporary directory/i }))
  expect(screen.getByLabelText('Temporary directory')).toHaveValue('/tmp/parquet')
  await userEvent.click(screen.getByRole('button', { name: /use system temporary directory/i }))
  expect(screen.getByLabelText('Temporary directory')).toHaveValue('')
})
