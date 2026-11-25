import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UntouchedBar } from '../src/renderer/screens/LocalReviewWindow'

const render = (props: Partial<Parameters<typeof UntouchedBar>[0]>) =>
  renderToStaticMarkup(createElement(UntouchedBar, { untouched: [], wholeFolder: false, busy: false, onShow: () => {}, onHide: () => {}, ...props }))

describe('the untouched bar', () => {
  it('says how many repos, files and lines the session is not traced to, names them and offers to show them', () => {
    const html = render({
      untouched: [
        { name: 'repo-a', root: '/scratch/repo-a', files: 3, additions: 1200, deletions: 40 },
        { name: 'repo-b', root: '/scratch/repo-b', files: 2, additions: 10, deletions: 5 }
      ]
    })
    expect(html).toContain('data-testid="review-untouched"')
    expect(html).toContain('2 more repos in this folder have changes not traced to this session')
    expect(html).toContain('5 files')
    expect(html).toContain('+1,210')
    expect(html).toContain('repo-a, repo-b')
    expect(html).toContain('Show them too')
    expect(html).toContain('data-testid="review-untouched-show"')
    expect(html).toContain('aria-label="Show them too: the other repos of this folder"')
    expect(html).not.toContain('review-untouched-hide')
  })

  it('uses the singular for one repo', () => {
    const html = render({ untouched: [{ name: 'repo-a', root: '/scratch/repo-a', files: 1, additions: 1, deletions: 0 }] })
    expect(html).toContain('1 more repo in this folder has changes not traced to this session')
  })

  it('says the whole folder is shown and offers to go back', () => {
    const html = render({ wholeFolder: true })
    expect(html).toContain('Showing every repo in this folder with changes')
    expect(html).toContain("Only this session&#x27;s repos")
    expect(html).toContain('data-testid="review-untouched-hide"')
    expect(html).toContain('aria-label="Show only this session&#x27;s repos"')
    expect(html).not.toContain('review-untouched-show')
  })
})
