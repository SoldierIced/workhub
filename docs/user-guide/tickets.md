# Tickets

The **Tickets** screen (⌘/Ctrl+3) shows the tickets assigned to you, grouped by sprint (**Active
sprint**, then **Backlog · no sprint**). Jira Cloud and Linear are supported.

## Set up

1. **Settings → Trackers → New tracker**.
2. Pick the provider:
   - **Jira**: the **Jira site** (for example `your-team.atlassian.net`), your **Account email** and
     an **API token** (create one at id.atlassian.com → Security → API tokens).
   - **Linear**: an **API key** (Linear → Settings → Security & access).
3. Optional: **Project keys** (comma separated, like `ABC, WEB`) so ticket links in titles and
   branches are matched exactly, and **Statuses to hide**.
4. **Test connection** shows who you are connected as. **Save tracker**.
5. Turn on **Use in the active profile**. Each profile uses one tracker.

The token is stored encrypted by the operating system, never in the settings file.

## Using it

- Each row shows the ticket, its status and how many pull requests and sessions mention it.
- Open a ticket to read it in Workhub or in its own window. From there you can change the status
  (**Move to…**), **Assign to me**, read the description, subtasks and comments, and **Add
  comment**. The ticket lists its **Pull requests** and **Sessions**, with **Show session**.
- **Talk with Claude** opens a Claude session about the ticket with a prompt for you to finish.
  **New session about this ticket** starts one with your preferred agent. **Open session** goes to
  the latest open session on it. **Open in the browser** and **Copy link** are there too.
- Ticket keys in sessions, pull requests and Slack messages show as chips; click **Open ticket** to
  see them without leaving the app.
- Home shows **Tickets in progress**.

## Notifications

With **Tickets** on under **Settings → General → Other notifications**, Workhub notifies about status
changes and about tickets assigned to you or taken away.

Next: [Slack](slack.md).
