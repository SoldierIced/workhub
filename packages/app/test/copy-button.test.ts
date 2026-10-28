import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '../src/renderer/components/atoms'
import { Markdown } from '../src/renderer/components/molecules/Markdown'

const render = (text: string) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Markdown, { text })))

describe('Markdown code blocks', () => {
  it('give every fenced block its own copy button', () => {
    const html = render('Run:\n\n```sh\nnpm test\n```\n\nThen:\n\n```\nnpm run build\n```')
    expect(html.match(/data-testid="copy-button"/g)).toHaveLength(2)
    expect(html).toContain('npm test')
  })

  it('leave inline code without one', () => {
    expect(render('Use `npm test` here.')).not.toContain('copy-button')
  })
})
