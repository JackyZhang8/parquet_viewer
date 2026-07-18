import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

import { AboutDialog } from './AboutDialog'

it('presents a spacious product introduction in English', () => {
  render(<AboutDialog language="en" onClose={() => undefined} />)

  const dialog = screen.getByRole('dialog', { name: 'About Parquet Viewer' })
  expect(dialog).toHaveClass('about-dialog')
  expect(screen.getByText('LOCAL DATA WORKSPACE')).toHaveClass('about-eyebrow')
  expect(screen.getByRole('heading', { name: 'See your Parquet data with clarity.' })).toBeInTheDocument()
  expect(dialog).toHaveTextContent('Explore schemas, inspect records, and run focused queries with confidence—without moving your data beyond your computer.')
})

it('uses the corresponding Chinese product introduction', () => {
  render(<AboutDialog language="zh" onClose={() => undefined} />)

  expect(screen.getByText('本地数据工作台')).toHaveClass('about-eyebrow')
  expect(screen.getByRole('heading', { name: '让 Parquet 数据，一目了然。' })).toBeInTheDocument()
  expect(screen.getByText('无需上传或迁移数据，即可浏览结构、查看记录并完成定向查询。')).toBeInTheDocument()
})
