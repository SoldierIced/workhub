/**
 * The schema of `workhub.db`, one step per version, applied in order and recorded in
 * `schema_migrations`. A step is never edited once released: a change is a new step.
 */
export interface Migration {
  version: number
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      -- One JSON value per piece of app state (open sessions, watcher memory, ledgers); the key is
      -- the base name of the JSON file it replaced (open-sessions.json → open-sessions).
      CREATE TABLE kv_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- One flow map per row, as written (validated when read, so a bad map is listed with its error).
      CREATE TABLE flow_maps (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- What is known of one measure of one scope (a hash of profile, connection and environment).
      CREATE TABLE flow_history_measures (
        scope TEXT NOT NULL,
        measure TEXT NOT NULL,
        settled_until INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (scope, measure)
      );
      -- The hourly aggregates of a measure (FlowHour as JSON), kept for FLOW_HISTORY_DAYS.
      CREATE TABLE flow_history_hours (
        scope TEXT NOT NULL,
        measure TEXT NOT NULL,
        hour_at INTEGER NOT NULL,
        json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (scope, measure, hour_at)
      );
      CREATE INDEX flow_history_hours_at ON flow_history_hours (hour_at);
    `
  },
  {
    version: 2,
    sql: `
      -- One agent session Workhub knows: opened in Workhub ('workhub') or only found in a transcript
      -- ('transcript'). The id is the agent's session id (Workhub's own for a plain terminal).
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        account_id TEXT,
        profile_id TEXT,
        cwd TEXT,
        work_path TEXT,
        project TEXT,
        title TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        active_ms INTEGER NOT NULL DEFAULT 0,
        last_model TEXT,
        source TEXT NOT NULL CHECK (source IN ('transcript', 'workhub')),
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_profile_started ON sessions (profile_id, started_at);
      CREATE INDEX sessions_agent ON sessions (agent);
      CREATE INDEX sessions_account ON sessions (account_id);
      CREATE INDEX sessions_cwd ON sessions (cwd);
      CREATE INDEX sessions_project ON sessions (project);
      -- One assistant message with usage (Codex: one token report; Kiro: one turn), read from the
      -- transcripts. msg_key is unique within the session, so reading a file again updates its rows
      -- (and a Claude message id is counted once across sessions: a forked session repeats them).
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        msg_key TEXT NOT NULL,
        at INTEGER NOT NULL,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        usd REAL,
        cwd TEXT,
        project TEXT,
        turn_ms INTEGER NOT NULL DEFAULT 0,
        sidechain INTEGER NOT NULL DEFAULT 0,
        UNIQUE (session_id, msg_key)
      );
      CREATE INDEX turns_at ON turns (at);
      CREATE INDEX turns_session_at ON turns (session_id, at);
      CREATE INDEX turns_cwd_at ON turns (cwd, at);
      CREATE INDEX turns_model_at ON turns (model, at);
      CREATE INDEX turns_project_at ON turns (project, at);
      CREATE INDEX turns_agent_key ON turns (agent, msg_key);
      -- How far each transcript was read for turns (byte offset and parser state), so a scan reads only what was appended.
      CREATE TABLE turn_files (
        path TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        account_id TEXT,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        offset INTEGER NOT NULL,
        head_len INTEGER NOT NULL DEFAULT 0,
        head_hash TEXT,
        state TEXT,
        scanned_at INTEGER NOT NULL
      );
      -- What a session is related to: pull requests (canonical URL), tickets (key), branches and worktrees (path).
      CREATE TABLE session_links (
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('pr', 'ticket', 'branch', 'worktree')),
        ref TEXT NOT NULL,
        source TEXT,
        at INTEGER NOT NULL,
        PRIMARY KEY (session_id, kind, ref)
      );
      CREATE INDEX session_links_ref ON session_links (kind, ref);
      -- Free tags the user puts on a session ("idea" labels for the reports).
      CREATE TABLE session_tags (
        session_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (session_id, tag)
      );
      CREATE INDEX session_tags_tag ON session_tags (tag);
      -- Every automation run, kept without a cap (the automations state keeps only the last ones).
      CREATE TABLE automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        profile_id TEXT,
        trigger TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        session_id TEXT,
        summary_json TEXT NOT NULL
      );
      CREATE INDEX automation_runs_automation ON automation_runs (automation_id, started_at);
      CREATE INDEX automation_runs_started ON automation_runs (started_at);
      CREATE INDEX automation_runs_session ON automation_runs (session_id);
      -- Pull request timeline: one row per event the sync detected (id: profile and the event's own id).
      CREATE TABLE pr_events (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER,
        url TEXT NOT NULL,
        kind TEXT NOT NULL,
        at INTEGER NOT NULL,
        actor TEXT,
        title TEXT,
        json TEXT NOT NULL
      );
      CREATE INDEX pr_events_profile_at ON pr_events (profile_id, at);
      CREATE INDEX pr_events_pr ON pr_events (repo, number, at);
      CREATE INDEX pr_events_url ON pr_events (url, at);
      -- Ticket timeline: one row per change the ticket watcher saw (status, assigned, left).
      CREATE TABLE ticket_events (
        id INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL,
        key TEXT NOT NULL,
        kind TEXT NOT NULL,
        at INTEGER NOT NULL,
        from_value TEXT,
        to_value TEXT,
        title TEXT,
        json TEXT NOT NULL,
        UNIQUE (profile_id, key, kind, at)
      );
      CREATE INDEX ticket_events_key ON ticket_events (key, at);
      CREATE INDEX ticket_events_profile_at ON ticket_events (profile_id, at);
    `
  },
  {
    version: 3,
    sql: `
      -- Turns older than the retention (USAGE_RETENTION_MONTHS), summed per local day, session,
      -- model, folder and project, priced or not (see retention.ts); at is the first turn's time.
      -- The session stays in sessions, with its links and tags, so every report groups and filters
      -- the summaries the way it did the turns, and counts each session once.
      CREATE TABLE turns_daily (
        day INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT,
        cwd TEXT,
        project TEXT,
        priced INTEGER NOT NULL,
        at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        usd REAL,
        turn_ms INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX turns_daily_at ON turns_daily (at);
      CREATE INDEX turns_daily_session ON turns_daily (session_id, at);
      CREATE INDEX turns_daily_day ON turns_daily (day, session_id);
    `
  },
  {
    version: 4,
    sql: `
      -- Merged pull requests kept for the Merged view: one row per profile and pull request (a merge does not change).
      CREATE TABLE merged_prs (
        profile_id TEXT NOT NULL,
        url TEXT NOT NULL,
        provider TEXT NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        branch TEXT NOT NULL,
        base TEXT NOT NULL,
        merged_at INTEGER NOT NULL,
        created_at INTEGER,
        additions INTEGER,
        deletions INTEGER,
        changed_files INTEGER,
        saved_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, url)
      );
      CREATE INDEX merged_prs_profile_at ON merged_prs (profile_id, merged_at);
      CREATE INDEX merged_prs_repo ON merged_prs (owner, repo, merged_at);
      -- Which search of the profile found each one (a scope change is a new search).
      CREATE TABLE merged_found (
        profile_id TEXT NOT NULL,
        search_key TEXT NOT NULL,
        url TEXT NOT NULL,
        PRIMARY KEY (profile_id, search_key, url)
      );
      -- The ranges each search read completely; at: when the read that set the range's newest end ended.
      CREATE TABLE merged_coverage (
        profile_id TEXT NOT NULL,
        search_key TEXT NOT NULL,
        since INTEGER NOT NULL,
        until INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX merged_coverage_key ON merged_coverage (profile_id, search_key, since);
    `
  },
  {
    version: 5,
    sql: `
      -- Which searches found a pull request: the daily prune deletes the rows no search found.
      CREATE INDEX merged_found_url ON merged_found (profile_id, url);
    `
  }
]
