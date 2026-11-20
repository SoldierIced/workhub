import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { fileParts, splitPath } from '../src/web/changes-pages'
import { PathText } from '../src/web/path-text'

describe('paths on the phone keep their end', () => {
  it('splits a path into a head that may give way and a tail that stays', () => {
    expect(splitPath('src/billing/invoices')).toEqual({ head: 'src/billing/', tail: 'invoices' })
    expect(splitPath('/home/me/code/acme/api', 2)).toEqual({ head: '/home/me/code/', tail: 'acme/api' })
    expect(splitPath('api')).toEqual({ head: '', tail: 'api' })
    expect(splitPath('code/api/', 2)).toEqual({ head: '', tail: 'code/api' })
    expect(splitPath('C:\\work\\acme\\api', 2)).toEqual({ head: 'C:\\work\\', tail: 'acme\\api' })
  })

  it('tells a changed file from its folder', () => {
    expect(fileParts('src/billing/invoices/rounding-strategy.test.ts')).toEqual({ name: 'rounding-strategy.test.ts', dir: 'src/billing/invoices' })
    expect(fileParts('README.md')).toEqual({ name: 'README.md', dir: '' })
  })

  it('draws the head as the part that is cut and the tail as the part that stays', () => {
    const html = renderToStaticMarkup(createElement(PathText, { path: '/tmp/a/b/acme/api', keep: 2 }))
    expect(html).toContain('<span class="min-w-0 truncate">/tmp/a/b/</span>')
    expect(html).toContain('<bdi dir="ltr">acme/api</bdi>')
    expect(html).toContain('title="/tmp/a/b/acme/api"')
    expect(renderToStaticMarkup(createElement(PathText, { path: 'api' }))).not.toContain('min-w-0 truncate"></span>')
  })
})
