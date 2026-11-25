import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_MODULES, type Profile, type ProfileHost } from '@workhub/core'
import type { HostStatus, WslDistrosResult } from '../src/shared/hosts-api'

/** Rendered on the server (no DOM): the controls are stand-ins that record their props, found by their accessible name. */
type Recorded = Record<string, unknown> & { 'aria-label'?: string; children?: ReactNode }
const controls: Recorded[] = []
vi.mock('../src/renderer/components/atoms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/components/atoms')>()
  const record = (tag: string) =>
    function Recording(props: Recorded) {
      controls.push(props)
      return createElement(tag, { 'aria-label': props['aria-label'] }, props.children)
    }
  return { ...actual, Select: record('select'), Button: record('button') }
})

import { TooltipProvider } from '../src/renderer/components/atoms'
import { folderForHost, folderPickError, hostChoices, shownFolderError, hostOfOptionValue, hostOptionValue, withProfileHost } from '../src/renderer/lib/profileHost'
import { ProfileHostField, ProfileHostPicker, type ProfileHostPickerProps } from '../src/renderer/screens/settings/ProfileHostField'
import { FoldersField, withOwnFields } from '../src/renderer/screens/settings/ProfileSections'

const UBUNTU: ProfileHost = { kind: 'wsl', distro: 'Ubuntu' }
const DISTROS: WslDistrosResult = {
  distros: [
    { name: 'Ubuntu', isDefault: true, state: 'Running', version: 2 },
    { name: 'Debian', isDefault: false, state: 'Stopped', version: 2 }
  ]
}
const profile = (over: Partial<Profile> = {}): Profile => ({ id: 'acme', name: 'Acme', connections: {}, accountIds: [], modules: { ...NO_MODULES }, ...over })
const wrap = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, el))
const control = (name: string) => {
  const found = controls.find((c) => c['aria-label'] === name || c['data-testid'] === name)
  if (!found) throw new Error(`no control "${name}"; have: ${controls.map((c) => c['aria-label']).join(' | ')}`)
  return found
}

beforeEach(() => {
  controls.length = 0
})
afterEach(() => vi.unstubAllGlobals())

describe('profile host choice', () => {
  it('maps the select values to profile hosts, this computer being no host at all', () => {
    expect(hostOptionValue(undefined)).toBe('local')
    expect(hostOptionValue(UBUNTU)).toBe('wsl:Ubuntu')
    expect(hostOfOptionValue('wsl:Ubuntu')).toEqual(UBUNTU)
    expect(hostOfOptionValue('local')).toBeUndefined()
    expect(hostOfOptionValue('wsl:')).toBeUndefined()
    expect(withProfileHost(profile(), UBUNTU)).toEqual(profile({ host: UBUNTU }))
    expect(withProfileHost(profile({ host: UBUNTU }), undefined)).toEqual(profile())
    expect('host' in withProfileHost(profile({ host: UBUNTU }), { kind: 'local' })).toBe(false)
  })

  it('lists this computer and the distributions, and keeps a saved one WSL no longer lists', () => {
    expect(hostChoices(DISTROS.distros, undefined).map((c) => [c.value, c.isDefault, c.missing])).toEqual([
      ['local', false, false],
      ['wsl:Ubuntu', true, false],
      ['wsl:Debian', false, false]
    ])
    expect(hostChoices([], { kind: 'wsl', distro: 'Gone' }).map((c) => [c.value, c.missing])).toEqual([
      ['local', false],
      ['wsl:Gone', true]
    ])
  })

  it('carries the host with the fields the profile form saves', () => {
    expect(withOwnFields(profile({ modules: { ...NO_MODULES } }), profile({ host: UBUNTU })).host).toEqual(UBUNTU)
    expect('host' in withOwnFields(profile({ host: UBUNTU }), profile())).toBe(false)
  })
})

describe('folders of a WSL profile', () => {
  it('stores a folder picked inside the distribution as its Linux path', () => {
    expect(folderForHost(UBUNTU, '\\\\wsl.localhost\\Ubuntu\\srv\\acme\\work')).toEqual({ ok: true, path: '/srv/acme/work' })
    expect(folderForHost(UBUNTU, '\\\\wsl$\\ubuntu\\srv\\acme')).toEqual({ ok: true, path: '/srv/acme' })
    expect(folderForHost(UBUNTU, '/srv/acme/api')).toEqual({ ok: true, path: '/srv/acme/api' })
  })

  it('refuses a Windows folder, or one of another distribution', () => {
    expect(folderForHost(UBUNTU, 'C:\\Users\\ana\\work')).toEqual({ ok: false, error: 'profileHost.folderNotWsl', params: { distro: 'Ubuntu' } })
    expect(folderForHost(UBUNTU, '\\\\server\\share\\acme')).toMatchObject({ ok: false, error: 'profileHost.folderNotWsl' })
    expect(folderForHost(UBUNTU, '\\\\wsl.localhost\\Debian\\srv')).toEqual({ ok: false, error: 'profileHost.folderOtherDistro', params: { picked: 'Debian', distro: 'Ubuntu' } })
  })

  it('leaves the folders of a profile on this computer as picked', () => {
    expect(folderForHost(undefined, 'C:\\Users\\ana\\work')).toEqual({ ok: true, path: 'C:\\Users\\ana\\work' })
    expect(folderForHost(undefined, '\\\\wsl.localhost\\Ubuntu\\srv')).toEqual({ ok: true, path: '\\\\wsl.localhost\\Ubuntu\\srv' })
  })

  it('adds the Linux path of a folder picked through \\\\wsl.localhost, and nothing for a Windows folder', async () => {
    const onChange = vi.fn()
    let picked = '\\\\wsl.localhost\\Ubuntu\\srv\\acme'
    vi.stubGlobal('window', { hub: { pickFolder: async () => picked } })
    wrap(createElement(FoldersField, { folders: ['/srv/old'], host: UBUNTU, onChange }))
    ;(control('profile-folder-add').onClick as () => void)()
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(['/srv/old', '/srv/acme']))

    onChange.mockClear()
    picked = 'D:\\acme'
    ;(control('profile-folder-add').onClick as () => void)()
    await new Promise((r) => setTimeout(r, 0))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('a folder picker error', () => {
  it('shows only while the folders and the host are the ones it was raised for', () => {
    const error = folderPickError('Pick a folder inside Ubuntu.', ['/srv/old'], UBUNTU)
    expect(shownFolderError(error, ['/srv/old'], UBUNTU)).toBe('Pick a folder inside Ubuntu.')
    // A valid folder was added (here, or by another picker of the form), or the host changed: it is stale.
    expect(shownFolderError(error, ['/srv/old', '/srv/acme'], UBUNTU)).toBeNull()
    expect(shownFolderError(error, ['/srv/old'], undefined)).toBeNull()
    expect(shownFolderError(null, ['/srv/old'], UBUNTU)).toBeNull()
  })
})

describe('ProfileHostPicker', () => {
  const render = (over: Partial<ProfileHostPickerProps> = {}) => {
    const props: ProfileHostPickerProps = { value: UBUNTU, savedHost: UBUNTU, distros: DISTROS, statuses: [], onChange: vi.fn(), onRetry: vi.fn(), ...over }
    return { html: wrap(createElement(ProfileHostPicker, props)), props }
  }
  const status = (s: Omit<HostStatus, 'id' | 'kind'>): HostStatus[] => [{ id: 'wsl:Ubuntu', kind: 'wsl', ...s }]

  it('offers this computer and each distribution, the default marked, and writes the choice', () => {
    const { html, props } = render({ value: undefined, savedHost: undefined })
    const select = control('Where sessions run')
    expect(select.value).toBe('local')
    expect((select.options as { label: string }[]).map((o) => o.label)).toEqual(['This computer', 'WSL: Ubuntu (default)', 'WSL: Debian'])
    expect(html).toContain('/home/&lt;you&gt;/work')
    expect(html).toContain('180 MB')
    ;(select.onChange as (v: string) => void)('wsl:Debian')
    expect(props.onChange).toHaveBeenCalledWith({ kind: 'wsl', distro: 'Debian' })
    ;(select.onChange as (v: string) => void)('local')
    expect(props.onChange).toHaveBeenLastCalledWith(undefined)
    expect(html).not.toContain('profile-host-status')
  })

  it('says a new choice starts on save, then follows the saved host', () => {
    expect(render({ savedHost: undefined }).html).toContain('Starts when you save.')
    expect(render({ statuses: status({ state: 'connecting' }) }).html).toContain('Starting Workhub in Ubuntu…')
    expect(render({ statuses: status({ state: 'installing', installProgress: { phase: 'downloading', received: 45_000_000, total: 180_000_000 } }) }).html).toContain(
      'Downloading Workhub for Ubuntu: 45 MB of 180 MB'
    )
    expect(render({ statuses: status({ state: 'installing', installProgress: { phase: 'unpacking' } }) }).html).toContain('Installing Workhub in Ubuntu…')
    expect(render({ statuses: status({ state: 'connected' }) }).html).toContain('Connected: this profile’s sessions run in Ubuntu.')
    expect(render({ statuses: status({ state: 'connected', warning: 'noControl' }) }).html).toContain('cannot reach Workhub’s tools')
    expect(render({ statuses: status({ state: 'unavailable', detail: 'WSL distributions are used only on Windows' }) }).html).toContain('WSL is not available here.')
  })

  it('shows a failure with its reason and a Retry for that host', () => {
    const { html, props } = render({ statuses: status({ state: 'failed', detail: 'the host process exited (1)' }) })
    expect(html).toContain('Could not start Workhub in Ubuntu: the host process exited (1).')
    expect(html).toContain('role="status"')
    ;(control('Retry starting Workhub in Ubuntu').onClick as () => void)()
    expect(props.onRetry).toHaveBeenCalledWith('wsl:Ubuntu')
  })

  it('says when WSL has no distribution', () => {
    expect(render({ value: undefined, distros: { distros: [], reason: 'none' } }).html).toContain('No WSL distribution found.')
  })
})

describe('ProfileHostField', () => {
  it('is not shown off Windows', () => {
    for (const platform of ['mac', 'linux']) {
      vi.stubGlobal('window', { hub: { platform } })
      expect(wrap(createElement(ProfileHostField, { value: UBUNTU, savedHost: UBUNTU, onChange: () => {} }))).toBe('')
    }
  })

  it('is shown on Windows', () => {
    vi.stubGlobal('window', { hub: { platform: 'windows' } })
    expect(wrap(createElement(ProfileHostField, { value: undefined, savedHost: undefined, onChange: () => {} }))).toContain('data-testid="profile-host"')
  })
})
