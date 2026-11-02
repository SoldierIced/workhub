import { describe, expect, it } from 'vitest'
import { hardBreaks } from '../src/renderer/components/molecules/Markdown'

describe('hardBreaks', () => {
  it('keeps single line breaks as breaks', () => {
    expect(hardBreaks('Metric: errors\nValue: 48')).toBe('Metric: errors  \nValue: 48')
  })
  it('leaves paragraphs, already broken lines and the last line alone', () => {
    expect(hardBreaks('one\n\ntwo')).toBe('one\n\ntwo')
    expect(hardBreaks('one  \ntwo')).toBe('one  \ntwo')
    expect(hardBreaks('only')).toBe('only')
  })
  it('never touches fenced code', () => {
    const code = '```\na\nb\n```'
    expect(hardBreaks(code)).toBe(code)
    expect(hardBreaks(`intro\n${code}`)).toBe(`intro\n${code}`)
  })
})
