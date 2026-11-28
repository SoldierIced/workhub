# Cooking

Cooking is a way of having an agent do a change without following it step by step. You ask once.
The agent takes every product decision and writes each one down with how to change it, has its plan
read by another model before it builds, has the result read by a reviewer that saw none of the
work, and comes back with finished work. While it works, the chat shows the job as a
[live board](live-boards.md).

It works in any git repository and with any agent that has the `workhub-cooking` skill.

## Starting it

Type `/cooking` and your request in the chat:

```text
/cooking after cancelling a slot and adding another, two slots end up with the same number
```

Workhub sends the agent your request, followed by a line that tells it to use the `workhub-cooking`
skill. The session is named after your request.

- `/cooking` with nothing after it sends nothing and shows its usage.
- Images you attach go with the request.
- When the session has reported its skills and `workhub-cooking` is not among them, nothing is sent
  and Workhub tells you where to install it.
- `/cooking` is a command of the chat composer of the desktop app. In the Terminal view, the phone
  app and automations, ask for the cooking method in words ("do this with the cooking method") or use the
  agent's own `/workhub-cooking` command.
- If you or the agent have a command named `cooking`, Workhub's takes its place in the chat.

## Installing the skill

**Settings → Agents → Workhub tools for agents → Install** copies Workhub's skills, this one
included, into each Claude Code folder and into the skills folder of Codex, OpenCode, Gemini CLI
and Kiro. After an update that adds a skill, that section shows them as incomplete ("7 of 8 installed")
until you press **Install** again. You can also copy `skills/workhub-cooking` from the Workhub repository into
`~/.claude/skills/` or a project's `.claude/skills/`.

## What the agent does

1. **Sizes the task.** A small one: it writes, and one reviewer reads the result. Anything larger
   that one agent can hold: a reader checks the plan first, then a reviewer reads the result. Work
   with two or more large separate areas: several writers in their own copies, then one reviewer of
   the whole. Six sub-agents at most.
2. **Decides and records.** It does not stop to ask about each choice. It asks you only about what
   cannot be undone, what goes outward (a commit, a push, a message to someone), what spends your
   money or quota, or a tie the project's own documentation does not break. When what you ask would
   break something the project documents, it tells you first.
3. **Writes** the test first, then the change and its documentation.
4. **Runs the real thing** on a case it builds, then the project's checks.
5. **Has it read** by a reviewer of another model, when the agent can choose the model. It fixes
   what the reviewer marks as needed before merging, has those fixes read once, and stops.
6. **Reports**: what was built, each check with its real result, each decision with how to change
   it, what the readers found, and what is left.

It does not commit, push or open a pull request unless you asked. The change stays in your working
folder; when [Review changes](review-before-pr.md) is available, the agent opens it for you.

## The board

With **Live boards** on for the profile (**Settings → Profiles → (profile) → Screens**), the chat's
board panel shows the job: its stages, the decisions with why each was taken and how to change it,
the checks with their results, the agents with their model, and a log. The board says **paused**
while the agent waits for your answer and **finished** at the end.

With Live boards off, the agent works the same and tells you once that the board could not be shown.

## What it costs, and when it pays

Cooking spends more than letting the agent work alone: in our measurements about four times the
cost, mostly on the readers. What it bought was fewer serious errors in what
the request did not spell out (data already stored, edge cases, what happens the second time). On
a light bug that was fully specified, every method passed the hidden tests, and the agent alone did
it for about a quarter of the cost. The numbers, how they were measured and their limits are in
[Cooking benchmarks](../cooking-benchmarks.md).
