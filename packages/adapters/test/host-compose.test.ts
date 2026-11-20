import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcpRuntime } from '../src/agent-acp'
import { ClaudeNativeRuntime, ClaudeSessionHistory, type ClaudeTranscriptReader } from '../src/agent-claude-native'
import { TerminalRuntime } from '../src/agent-terminal'
import { runGit } from '../src/git-review'
import { composeExecutionServices, type ExecutionServiceDeps } from '../src/host'
import { ClaudeTranscriptReader as ClaudeTranscripts } from '../src/transcript-claude'
import { CodexSessionHistory, CodexTranscriptReader } from '../src/transcript-codex'
import { KiroSessionHistory, KiroTranscriptReader } from '../src/transcript-kiro'
import { OpenCodeSessionHistory, OpenCodeTranscriptReader } from '../src/transcript-opencode'

const readTranscript: ClaudeTranscriptReader = async () => []

function deps(overrides: Partial<ExecutionServiceDeps> = {}): ExecutionServiceDeps {
  return {
    bridgeDir: '/w/acme/bridge',
    sessionPath: () => '/w/acme/bin',
    fallbackPath: ['/w/acme/claude-bin'],
    extraPath: ['/w/acme/node_modules/.bin'],
    clientVersion: '2.0.0-test',
    claudeTranscripts: readTranscript,
    ...overrides
  }
}

describe('composeExecutionServices', () => {
  it('builds the three runtimes with the PATH getters and folders it was given', () => {
    const d = deps()
    const { runtimes, terminal } = composeExecutionServices(d)

    expect(Object.keys(runtimes)).toEqual(['native', 'acp', 'terminal'])
    expect(runtimes.native).toBeInstanceOf(ClaudeNativeRuntime)
    expect(runtimes.acp).toBeInstanceOf(AcpRuntime)
    expect(runtimes.terminal).toBeInstanceOf(TerminalRuntime)
    expect(terminal).toBe(runtimes.terminal)

    expect(runtimes.native['options']).toEqual({ bridgeDir: '/w/acme/bridge', path: d.sessionPath })
    expect(runtimes.acp['options']).toEqual({ clientName: 'workhub', clientVersion: '2.0.0-test', extraPath: ['/w/acme/node_modules/.bin'], path: d.sessionPath })
    expect(runtimes.terminal['options']).toEqual({ path: d.sessionPath, fallbackPath: ['/w/acme/claude-bin'] })
  })

  it('keys past sessions by agent id, Claude reading transcripts through the injected reader', () => {
    const { history } = composeExecutionServices(deps())

    expect(Object.keys(history)).toEqual(['claude', 'kiro', 'opencode', 'codex'])
    expect(history.claude).toBeInstanceOf(ClaudeSessionHistory)
    expect(history.kiro).toBeInstanceOf(KiroSessionHistory)
    expect(history.opencode).toBeInstanceOf(OpenCodeSessionHistory)
    expect(history.codex).toBeInstanceOf(CodexSessionHistory)
    expect(history.claude['options']).toEqual({ bridgeDir: '/w/acme/bridge', transcripts: readTranscript })
  })

  it('lists the live transcript readers in the order sessions try them', () => {
    const { transcripts } = composeExecutionServices(deps())

    expect(transcripts.map((r) => r.constructor)).toEqual([ClaudeTranscripts, KiroTranscriptReader, OpenCodeTranscriptReader, CodexTranscriptReader])
  })

  it('points the Kiro readers at the given data folder, or at the default one', () => {
    const custom = composeExecutionServices(deps({ kiroDir: '/w/acme/kiro' }))
    expect(custom.history.kiro['sessionsDir']).toBe(join('/w/acme/kiro', 'sessions'))
    expect((custom.transcripts[1] as KiroTranscriptReader)['sessionsDir']).toBe(join('/w/acme/kiro', 'sessions'))

    const fallback = composeExecutionServices(deps())
    expect(fallback.history.kiro['sessionsDir']).not.toBe(join('/w/acme/kiro', 'sessions'))
  })

  it('runs git with the local runner', () => {
    expect(composeExecutionServices(deps()).git).toBe(runGit)
  })

  it('builds a fresh set on every call', () => {
    const a = composeExecutionServices(deps())
    const b = composeExecutionServices(deps())
    expect(a.runtimes.native).not.toBe(b.runtimes.native)
    expect(a.history.claude).not.toBe(b.history.claude)
  })
})
