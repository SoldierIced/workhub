import type { PromptDefinition } from '../types'

/** The editable prompts of prompts the app's screens draft (links, pull request feedback, Health, flow maps). Their defaults follow the UI language: `i18nKey` names the renderer text. */
export const RENDERER_PROMPTS = {
  'links.reviewPr': {
    area: 'links',
    placeholders: ['name', 'title', 'url', 'branch', 'base', 'author'],
    i18nKey: 'links.prompt.review',
    defaultText: 'Review pull request {name} "{title}" ({url}).\n\nIt merges {branch} into {base} and was opened by {author}.\n\nRead its diff (with the host CLI, or git diff against {base}) and the code around it in this folder. Look for bugs, missing tests, unclear names and risky changes, and list what you would change, most important first. Do not change anything or post any comment until I agree.'
  },
  'links.ticket': {
    area: 'links',
    placeholders: ['key', 'title', 'url'],
    i18nKey: 'links.prompt.ticket',
    defaultText: 'I want to work on ticket {key}: "{title}".\n\nTicket link: {url}\n\nRead the ticket and the code it touches in this folder, and tell me how you would approach it and what you would check first. Do not change anything until I agree.'
  },
  'links.ticketNoUrl': {
    area: 'links',
    placeholders: ['key', 'title'],
    i18nKey: 'links.prompt.ticketNoUrl',
    defaultText: 'I want to work on ticket {key}: "{title}".\n\nRead the ticket and the code it touches in this folder, and tell me how you would approach it and what you would check first. Do not change anything until I agree.'
  },
  'links.fixCi': {
    area: 'links',
    placeholders: ['name', 'url', 'branch', 'data'],
    slots: ['data'],
    i18nKey: 'prFeedback.prompt.fixCi',
    defaultText: 'CI failed on pull request {name} ({url}), branch `{branch}`.\n\n{data}\n\nWork on the branch `{branch}` (check it out first if this folder is on another branch). For each failing check, read its log (with the host CLI), find the cause and fix it, then run the same checks locally. Tell me what failed and what you changed. Do not push or comment on the pull request until I agree.'
  },
  'links.addressReview': {
    area: 'links',
    placeholders: ['name', 'url', 'branch', 'data'],
    slots: ['data'],
    i18nKey: 'prFeedback.prompt.addressReview',
    defaultText: 'Pull request {name} ({url}), branch `{branch}`, has review feedback to address.\n\n{data}\n\nWork on the branch `{branch}` (check it out first if this folder is on another branch). Address each comment in the code, or tell me why you would not change it, then list what you did for each one. Do not push, reply or resolve threads on the pull request until I agree.'
  },
  'health.ask': {
    area: 'health',
    placeholders: [],
    i18nKey: 'healthPrompt.ask',
    defaultText: 'Find the cause in this repository and propose a fix; do not change anything yet.'
  },
  'health.flowAsk': {
    area: 'health',
    placeholders: [],
    i18nKey: 'healthPrompt.flow.ask',
    defaultText: 'Find the cause in this repository, starting with the code path of this endpoint and what it calls. Tell me what you find and how you would fix it before changing anything.'
  },
  'health.togetherAsk': {
    area: 'health',
    placeholders: [],
    i18nKey: 'healthPrompt.together.ask',
    defaultText: 'Review them together: group the ones that share a cause, rank by impact, and propose fixes per repository; do not change anything yet.'
  },
  'health.flowMapAsk': {
    area: 'health',
    placeholders: [],
    i18nKey: 'flowMapPrompt.ask',
    defaultText: 'Please: (1) say where this flow spends its time and whether that is expected; (2) propose the `measure` entries (and new nodes or hops) that would complete the map, using names as APM reports them, and offer to write the updated file; (3) if a part looks slow or failing, suggest what to check in its repository. Ask before changing anything.'
  }
} satisfies Record<string, PromptDefinition>
