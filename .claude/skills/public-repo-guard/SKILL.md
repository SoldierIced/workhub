---
name: public-repo-guard
description: "Trigger: any edit, test fixture, doc, commit message or push in this public repository. Keep employer names, internal ticket keys, real repo or service names, channel names and home paths out of everything that reaches git."
---

# Public repository guard

This repository is public. Its history must never carry private data from the people who work on it:
employer or client names, internal ticket keys, real repository or microservice names, Slack channel
names, real people, hostnames or home-directory paths.

## Rules

1. **Fixtures and examples are synthetic.** Never copy real transcripts, configs, branch names, ticket
   keys, PR URLs or file paths into tests, docs or comments. Use neutral stand-ins: `acme`, `~/work`,
   `PAY-123`, `TEAM-45`, `#team-reviews`, `/w/acme/api`, `ana`.
2. **Measuring with real data is fine; publishing it is not.** When you read real local data to
   reproduce a bug, rewrite what you learned into synthetic fixtures before anything is staged.
3. **Comments and docs too.** An example in a doc comment (`e.g. open-<company>`) is as public as code.
4. **Commit messages and PR text** follow the same rule.
5. **Delegating?** Put these rules in the sub-agent's brief: it does not read this file by itself.

## The automatic check

`scripts/check-private-terms.sh` runs from the repo's hooks (`.githooks`, enabled by `npm install`):
pre-commit checks the staged lines, commit-msg the message, pre-push every outgoing commit. The terms
live outside the repo, in `$WORKHUB_PRIVATE_TERMS` or `~/.config/workhub/private-terms.txt`, one
case-insensitive regex per line; without that file the hooks pass.

Before finishing any task here, run:

```sh
scripts/check-private-terms.sh tree
```

Never bypass the hooks (`--no-verify`) to get past a match: remove the data instead. If a term already
reached a pushed commit, stop and tell the user; cleaning published history is their decision.
