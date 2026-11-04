import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { parseSettingsTarget } from '../src/renderer/lib/settingsTarget'
import { SettingsGroup } from '../src/renderer/screens/settings/SettingsLayout'

describe('Settings targets', () => {
  it('reads a tab, and a group of it after #', () => {
    expect(parseSettingsTarget('general#updates')).toEqual({ tab: 'general', group: 'updates' })
    expect(parseSettingsTarget('profiles')).toEqual({ tab: 'profiles' })
    expect(parseSettingsTarget(undefined)).toEqual({})
    expect(parseSettingsTarget('#updates')).toEqual({ group: 'updates' })
  })

  it('names a group for the spotlight, and marks every group so the others can dim', () => {
    const named = renderToStaticMarkup(createElement(SettingsGroup, { title: 'Updates', anchor: 'updates', children: 'rows' }))
    expect(named).toContain('data-settings-group="updates"')
    const plain = renderToStaticMarkup(createElement(SettingsGroup, { title: 'Other', children: 'rows' }))
    expect(plain).toContain('data-settings-group=""')
  })
})
