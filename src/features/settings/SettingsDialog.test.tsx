import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import { SettingsDialog } from './SettingsDialog'

const settings = {
  language: 'en' as const,
  theme: 'system' as const,
  batchSize: 500,
  previewLimit: 10_000,
  memoryLimitMb: 512,
  tempDirectory: null,
  tempDiskWarningMb: 1024,
  concurrency: 2,
  restoreTabs: true,
}

it('applies every stability setting without a save action', async () => {
  const onChange = vi.fn(async (value) => value)
  render(<SettingsDialog settings={settings} onChange={onChange} onClose={() => undefined} pickDirectory={async () => null} />)

  await userEvent.selectOptions(screen.getByLabelText('Theme'), 'dark')
  await userEvent.clear(screen.getByLabelText('Batch size')); await userEvent.type(screen.getByLabelText('Batch size'), '750')
  await userEvent.clear(screen.getByLabelText('Preview row limit')); await userEvent.type(screen.getByLabelText('Preview row limit'), '25000')
  await userEvent.clear(screen.getByLabelText('Memory limit MB')); await userEvent.type(screen.getByLabelText('Memory limit MB'), '900')
  await userEvent.clear(screen.getByLabelText('Disk warning MB')); await userEvent.type(screen.getByLabelText('Disk warning MB'), '2048')
  await userEvent.selectOptions(screen.getByLabelText('Concurrent queries'), '3')
  await userEvent.click(screen.getByLabelText('Restore tabs on startup'))

  expect(onChange).toHaveBeenLastCalledWith({ ...settings, theme: 'dark', batchSize: 750, previewLimit: 25000,
    memoryLimitMb: 900, tempDiskWarningMb: 2048, concurrency: 3, restoreTabs: false })
  expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument()
})

it('applies the selected language immediately', async () => {
  const onChange = vi.fn(async (value) => value)
  render(<SettingsDialog settings={settings} onChange={onChange} onClose={() => undefined} pickDirectory={async () => null} />)

  await userEvent.selectOptions(screen.getByLabelText('Language'), 'zh')

  expect(onChange).toHaveBeenCalledWith({ ...settings, language: 'zh' })
})

it('selects and clears a temporary directory', async () => {
  const onChange = vi.fn(async (value) => value)
  render(<SettingsDialog settings={settings} onChange={onChange} onClose={() => undefined} pickDirectory={async () => '/tmp/parquet'} />)
  await userEvent.click(screen.getByRole('button', { name: /choose temporary directory/i }))
  expect(screen.getByLabelText('Temporary directory')).toHaveValue('/tmp/parquet')
  await userEvent.click(screen.getByRole('button', { name: /use system temporary directory/i }))
  expect(screen.getByLabelText('Temporary directory')).toHaveValue('')
  expect(onChange).toHaveBeenLastCalledWith({ ...settings, tempDirectory: null })
})

it('uses a dedicated visual checkbox for restoring tabs', () => {
  render(<SettingsDialog settings={settings} onChange={async (value) => value} onClose={() => undefined} pickDirectory={async () => null} />)

  const checkbox = screen.getByLabelText('Restore tabs on startup')
  expect(checkbox).toHaveClass('settings-check-input')
  expect(checkbox.nextElementSibling).toHaveClass('settings-check-box')
})
