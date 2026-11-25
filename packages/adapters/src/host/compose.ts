// The execution services a session runs on: agent runtimes, transcript readers, past-session
// sources and git. Built here, without Electron, so the app and a `workhub host` process build the
// same set; whatever only the app has (its PATH, its transcript worker) comes in as plain values.
import type { TranscriptReader } from '@workhub/core'
import { AcpRuntime } from '../agent-acp'
import { ClaudeNativeRuntime, ClaudeSessionHistory, type ClaudeTranscriptReader } from '../agent-claude-native'
import { TerminalRuntime } from '../agent-terminal'
import { runGit, type GitRunner } from '../git-review'
import { ClaudeTranscriptReader as ClaudeLiveTranscriptReader } from '../transcript-claude'
import { CodexSessionHistory, CodexTranscriptReader } from '../transcript-codex'
import { KiroSessionHistory, KiroTranscriptReader } from '../transcript-kiro'
import { OpenCodeSessionHistory, OpenCodeTranscriptReader } from '../transcript-opencode'

export interface ExecutionServiceDeps {
  /** Folder holding the Agent SDK bridge (`bridge.mjs`, `sessions.mjs`). */
  bridgeDir: string
  /** The PATH a session starts with, read at each start; the process PATH when it returns undefined. */
  sessionPath: () => string | undefined
  /** Folders put last on a terminal session's PATH (the bundled Claude Code binary, when present). */
  fallbackPath: string[]
  /** Folders prepended to an ACP agent's PATH (agent adapters installed with the app). */
  extraPath: string[]
  /** The version ACP agents are told the client runs. */
  clientVersion: string
  /** Kiro's data folder; `~/.kiro` when unset. */
  kiroDir?: string
  /** Reads a Claude transcript's conversation for past sessions (the app: in its transcript worker). */
  claudeTranscripts?: ClaudeTranscriptReader
  /** Where a runtime reports what it could not tell the session (a prompt Claude Code never received). */
  log?: (message: string) => void
}

export interface ExecutionServices {
  runtimes: { native: ClaudeNativeRuntime; acp: AcpRuntime; terminal: TerminalRuntime }
  /** The same runtime as `runtimes.terminal`: the one shell sessions and terminal agents run in. */
  terminal: TerminalRuntime
  /** Live transcript readers, in the order a session tries them. */
  transcripts: TranscriptReader[]
  /** Past sessions per agent id. */
  history: { claude: ClaudeSessionHistory; kiro: KiroSessionHistory; opencode: OpenCodeSessionHistory; codex: CodexSessionHistory }
  /** Runs git where the repositories live. */
  git: GitRunner
}

/** Builds a fresh set of execution services; nothing starts until a session or reader is used. */
export function composeExecutionServices(deps: ExecutionServiceDeps): ExecutionServices {
  const { bridgeDir, sessionPath, fallbackPath, extraPath, clientVersion, kiroDir, claudeTranscripts, log } = deps
  const terminal = new TerminalRuntime({ path: sessionPath, fallbackPath })
  const runtimes = {
    native: new ClaudeNativeRuntime({ bridgeDir, path: sessionPath, log }),
    acp: new AcpRuntime({
      clientName: 'workhub',
      clientVersion,
      extraPath,
      path: sessionPath
    }),
    terminal
  }
  const claudeHistory = new ClaudeSessionHistory({ bridgeDir, transcripts: claudeTranscripts })
  // The readers behind kiro, opencode and codex (PLAN D9).
  const history = { claude: claudeHistory, kiro: new KiroSessionHistory({ kiroDir }), opencode: new OpenCodeSessionHistory(), codex: new CodexSessionHistory() }
  const transcripts: TranscriptReader[] = [new ClaudeLiveTranscriptReader(), new KiroTranscriptReader({ kiroDir }), new OpenCodeTranscriptReader(), new CodexTranscriptReader()]
  return { runtimes, terminal, transcripts, history, git: runGit }
}
