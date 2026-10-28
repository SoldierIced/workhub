import { describe, expect, it } from 'vitest'
import {
  agentSlashCommands,
  CLAUDE_BUILTIN_COMMANDS,
  filterSlashCommands,
  knownAgentCommands,
  parseSlashCommand,
  readSlashCommand,
  slashQuery,
  uniqueSlashCommands,
  type SlashCommandInfo
} from '../src'

const cmd = (name: string, group: SlashCommandInfo['group'] = 'agent'): SlashCommandInfo => ({ name, group })

describe('parseSlashCommand', () => {
  it('reads the name and the trimmed arguments', () => {
    expect(parseSlashCommand('/rename  Payments refactor ')).toEqual({ name: 'rename', args: 'Payments refactor' })
    expect(parseSlashCommand('  /compact')).toEqual({ name: 'compact', args: '' })
    expect(parseSlashCommand('/acme:lint src/a.ts')).toEqual({ name: 'acme:lint', args: 'src/a.ts' })
    expect(parseSlashCommand('/review\nline two')).toEqual({ name: 'review', args: 'line two' })
  })

  it('is not fooled by plain prompts or paths', () => {
    expect(parseSlashCommand('rename this')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()
    expect(parseSlashCommand('/w/acme/api is broken')).toBeNull()
  })
})

describe('slashQuery', () => {
  it('is the word typed after the slash, until the first space', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/ren')).toBe('ren')
    expect(slashQuery('/rename ')).toBeNull()
    expect(slashQuery('hello /x')).toBeNull()
  })
})

describe('filterSlashCommands', () => {
  const all = [cmd('compact'), cmd('pr-comments'), cmd('commit', 'skill'), cmd('rename', 'workhub'), cmd('context'), cmd('acme:compose', 'skill')]

  it('groups Workhub, agent and skills, prefix matches before substring matches', () => {
    expect(filterSlashCommands(all, 'com').map((c) => `${c.group}:${c.name}`)).toEqual(['agent:compact', 'agent:pr-comments', 'skill:commit', 'skill:acme:compose'])
  })

  it('lists everything for a bare slash, case-insensitively', () => {
    expect(filterSlashCommands(all, '').map((c) => c.name)).toEqual(['rename', 'compact', 'context', 'pr-comments', 'commit', 'acme:compose'])
    expect(filterSlashCommands(all, 'RE').map((c) => c.name)).toEqual(['rename'])
  })
})

describe('agent commands', () => {
  it('keeps the first entry of a name, so Workhub\'s own command hides the agent\'s', () => {
    expect(uniqueSlashCommands([cmd('rename', 'workhub'), cmd('Rename'), cmd('compact')])).toEqual([cmd('rename', 'workhub'), cmd('compact')])
  })

  it('shows the known built-ins until the agent reports its own list', () => {
    expect(agentSlashCommands('claude', undefined)).toBe(CLAUDE_BUILTIN_COMMANDS)
    expect(agentSlashCommands('claude', [])).toBe(CLAUDE_BUILTIN_COMMANDS)
    expect(agentSlashCommands('claude', [cmd('deploy', 'skill')])).toEqual([cmd('deploy', 'skill')])
    expect(knownAgentCommands('kiro').map((c) => c.name)).toContain('agent')
    expect(knownAgentCommands('codex').map((c) => c.name)).toContain('review')
    expect(knownAgentCommands('shell')).toEqual([])
  })

  it('reads a reported command in the SDK, ACP and Kiro shapes', () => {
    expect(readSlashCommand({ name: 'compact', description: 'Compact', argumentHint: '[instructions]' }, 'agent')).toEqual({ name: 'compact', description: 'Compact', argumentHint: '[instructions]', group: 'agent' })
    expect(readSlashCommand({ name: 'review', input: { hint: '<branch>' } }, 'agent')).toEqual({ name: 'review', argumentHint: '<branch>', group: 'agent' })
    expect(readSlashCommand({ name: '/agent', description: ' ' }, 'agent')).toEqual({ name: 'agent', group: 'agent' })
    expect(readSlashCommand({ name: '' }, 'agent')).toBeNull()
    expect(readSlashCommand('compact', 'agent')).toBeNull()
  })
})
