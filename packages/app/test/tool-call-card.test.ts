import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ToolResultView } from '@workhub/core'
import { ToolCallCard, withoutExitLine } from '../src/renderer/components/organisms/ToolCallCard'

const command = (result: ToolResultView, status = 'failed') =>
  renderToStaticMarkup(
    createElement(ToolCallCard, { title: 'Bash', status, view: { kind: 'command', command: 'git commit -m "x"' }, result })
  )

/** The classes of the <pre> that holds the output (the last one; the first shows the command). */
const outputClasses = (html: string) => [...html.matchAll(/<pre class="([^"]*)"/g)].at(-1)?.[1] ?? ''

describe('withoutExitLine', () => {
  it('drops the leading exit line, with or without the Error prefix', () => {
    expect(withoutExitLine('Exit code 1\nnothing to commit')).toBe('nothing to commit')
    expect(withoutExitLine('Error: Exit code 2\nboom')).toBe('boom')
    expect(withoutExitLine('Exit code 1')).toBe('')
  })

  it('leaves other text alone', () => {
    expect(withoutExitLine('build ok\nExit code 1')).toBe('build ok\nExit code 1')
    expect(withoutExitLine(undefined)).toBeUndefined()
  })
})

describe('ToolCallCard command output', () => {
  it('shows a non-zero exit in the header but the output in the normal tone, without the exit line', () => {
    const html = command({ text: 'Exit code 1\nnothing to commit, working tree clean', isError: true, exitCode: 1 })
    expect(html).toContain('nothing to commit, working tree clean')
    expect(html).not.toContain('Exit code 1\n')
    expect(outputClasses(html)).toContain('text-muted')
    expect(outputClasses(html)).not.toContain('text-danger')
  })

  it('keeps a failure without an exit code (blocked, timed out) in the danger tone', () => {
    const html = command({ text: 'Command timed out', isError: true })
    expect(outputClasses(html)).toContain('text-danger')
  })
})
