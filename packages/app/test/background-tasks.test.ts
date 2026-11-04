import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BackgroundTaskSummary } from '@workhub/core'
import { waitingTasks } from '../src/renderer/lib/backgroundTasks'
import { BackgroundTasksNotice } from '../src/renderer/screens/sessions/BackgroundTasksNotice'

const task = (id: string, kind: BackgroundTaskSummary['kind'], since: number, description = `Task ${id}`): BackgroundTaskSummary => ({ id, kind, description, since })

describe('waitingTasks', () => {
  it('keeps commands, watchers and workflows, oldest first, and leaves sub-agents to their own list', () => {
    const list = waitingTasks([task('b', 'shell', 30), task('a', 'agent', 10), task('m', 'monitor', 20)])
    expect(list.map((t) => t.id)).toEqual(['m', 'b'])
    expect(waitingTasks(undefined)).toEqual([])
    expect(waitingTasks([task('a', 'agent', 1)])).toEqual([])
  })
})

describe('BackgroundTasksNotice', () => {
  it('names each task with its kind and how long it has run, and counts the rest', () => {
    const tasks = [task('1', 'shell', 0, 'Wait for CI checks'), task('2', 'monitor', 0), task('3', 'workflow', 0), task('4', 'other', 0)]
    const html = renderToStaticMarkup(createElement(BackgroundTasksNotice, { tasks, now: 125_000 }))
    expect(html).toContain('Wait for CI checks')
    expect(html).toContain('2 min 5 s')
    expect(html.match(/data-testid="background-task"/g)).toHaveLength(3)
    expect(html).toContain('and 1 more')
  })

  it('renders nothing without tasks', () => {
    expect(renderToStaticMarkup(createElement(BackgroundTasksNotice, { tasks: [], now: 0 }))).toBe('')
  })
})
