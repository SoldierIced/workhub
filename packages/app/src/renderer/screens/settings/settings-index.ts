import type { MessageKey } from "../../i18n/translate";
import { AGENTS_INDEX } from "./agents-index";
import { CONNECTIONS_INDEX } from "./connections-index";
import { NOTIFICATIONS_INDEX } from "./notifications-index";
import {
  PROFILE_SCREEN_LABEL,
  PROFILE_TABS,
  SETTINGS_SECTIONS,
  type ProfileScreen,
  type ProfileTab,
  type SettingsNavGroup,
  type SettingsSectionId,
} from "./sections";

/**
 * One searchable row of Settings: its label, hint and help (i18n keys, so the index works in the
 * active language) and the subgroup heading it sits under. Sections that are not on screen are not
 * rendered, so the index is this static table instead of being collected from the mounted rows.
 * A row of a profile names its `tab` (and, in Screens, its `screen`): a hit opens the profile on it.
 */
export interface SettingsIndexEntry {
  section: SettingsSectionId;
  /** The row's own id (`data-setting-id`), for sections that point at their rows themselves (Notifications: its `initialId`). */
  id?: string;
  label: MessageKey;
  hint?: MessageKey;
  help?: MessageKey;
  subgroup?: MessageKey;
  tab?: ProfileTab;
  screen?: ProfileScreen;
  /** A row of one profile (the profile's own entry): the hit opens that profile, not the open one. */
  profileId?: string;
  /** A label that is not an i18n key (a profile's name); `label` is then only the row's key. */
  text?: string;
  /** The row to point at when this one sits behind a closed "Adjust…" (its label is not on screen). */
  focus?: MessageKey;
  /** Only on some computers: `workhub1` while the Workhub 1 import shows. */
  only?: "workhub1";
}

type Row = readonly [label: MessageKey, hint?: MessageKey, help?: MessageKey];
type Extra = Partial<
  Pick<SettingsIndexEntry, "tab" | "screen" | "focus" | "only">
>;

const rows = (
  section: SettingsSectionId,
  subgroup: MessageKey | undefined,
  list: readonly Row[],
  extra: Extra = {},
): SettingsIndexEntry[] =>
  list.map(([label, hint, help]) => ({
    section,
    label,
    ...(hint ? { hint } : {}),
    ...(help ? { help } : {}),
    ...(subgroup ? { subgroup } : {}),
    ...extra,
  }));

/** Rows of one tab of a profile (`screen`: one screen of the Screens tab). */
const profileRows = (
  tab: ProfileTab,
  subgroup: MessageKey | undefined,
  list: readonly Row[],
  screen?: ProfileScreen,
) => rows("profiles", subgroup, list, { tab, ...(screen ? { screen } : {}) });

export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  // Remote access
  ...rows("remote", "remote.group.relay", [
    ["remote.enable", "remote.enableHint"],
    ["remote.relayUrl", "remote.relayUrlHint"],
    ["remote.desktopName", "remote.desktopNameHint"],
  ]),
  ...rows("remote", "remote.group.pair", [["remote.pair.start", "remote.pair.scan"]]),
  ...rows("remote", "remote.group.devices", [["remote.devices.revoke"]]),
  // General
  ...rows("general", "settingsV2.general.appearanceGroup", [
    ["settings.language", "settings.languageHint", "help.general.interface"],
    ["settingsV2.general.theme", "settings.themeHint", "help.appearance.base"],
    [
      "settingsV2.general.terminalColors",
      "settingsV2.general.terminalColorsHint",
      "help.appearance.theme",
    ],
    ["settingsV2.general.themeApp", "appearance.themeAppHint"],
    ["settingsV2.general.textSizes"],
  ]),
  ...rows(
    "general",
    "settingsV2.general.appearanceGroup",
    [
      [
        "appearance.textSize",
        "appearance.textSizeHint",
        "help.appearance.text",
      ],
      ["appearance.chatSize", "appearance.chatSizeHint"],
      ["appearance.fontFamily", undefined, "help.appearance.terminalFont"],
      ["appearance.fontSize"],
    ],
    { focus: "settingsV2.general.textSizes" },
  ),
  ...rows("general", "settingsV2.general.openClose", [
    [
      "settingsV2.general.reopenSessions",
      "settingsV2.general.reopenSessionsHint",
      "help.general.sessions",
    ],
    [
      "settingsV2.general.keepInTray",
      "settingsV2.general.keepInTrayHint",
      "help.general.menuBar",
    ],
  ]),
  ...rows("general", "voice.group", [
    ["settingsV2.voice.default", "voice.defaultHint", "voice.help"],
    ["settingsV2.voice.voiceRate"],
    ["settingsV2.voice.listenModel", "voice.listenModelHint"],
  ]),
  ...rows("general", "updates.group", [
    [
      "settingsV2.general.checkUpdates",
      "updates.checkHint",
      "help.general.updates",
    ],
  ]),

  // Notifications and alerts
  ...NOTIFICATIONS_INDEX.map((entry): SettingsIndexEntry => ({
    ...entry,
    section: "notifications",
  })),

  // Agents and Connections: their sections name their own rows
  ...AGENTS_INDEX.map((entry): SettingsIndexEntry => ({
    ...entry,
    section: "agents",
  })),
  ...CONNECTIONS_INDEX.map((entry): SettingsIndexEntry => ({
    ...entry,
    section: "connections",
  })),

  // Profiles: the list
  ...rows("profiles", undefined, [
    ["settingsV2.profiles.new", "settingsV2.intro.profiles"],
    ["settingsV2.profiles.duplicateHint"],
  ]),

  // A profile › Folders (with the header, on every tab)
  ...profileRows("folders", undefined, [
    ["settings.name"],
    ["sidebar.profileColor"],
    ["settings.folders", "settings.foldersHint", "help.profile.folders"],
    ["settings.defaultFolder", "settings.defaultFolderHint"],
  ]),
  ...profileRows("folders", "profileExtra.symbol", [
    ["profileExtra.symbol", undefined, "profileExtra.symbolHelp"],
  ]),
  ...profileRows("folders", "profileExtra.folderFlags", [
    ["profileExtra.onlyGitRepos", undefined, "profileExtra.folderFlagsHelp"],
    ["profileExtra.subfolders", "profileExtra.subfoldersHint"],
    ["profileExtra.folderWorktrees", "profileExtra.folderWorktreesHint"],
  ]),
  ...profileRows("folders", "profileExtra.worktrees", [
    [
      "profileExtra.worktreesEnabled",
      "profileExtra.worktreesEnabledHint",
      "profileExtra.worktreesHelp",
    ],
    ["profileExtra.worktreesLocation", "profileExtra.worktreesLocationHint"],
    ["profileExtra.worktreesPrefix", "profileExtra.worktreesPrefixHint"],
    ["profileExtra.worktreesBase", "profileExtra.worktreesBaseHint"],
    ["profileExtra.worktreesOnClose"],
  ]),

  // A profile › Screens: one row per screen, then each screen's settings
  ...profileRows("screens", undefined, [
    [
      "nav.pullRequests",
      "settings.modules.pullRequestsHint",
      "help.profile.connections",
    ],
    ["module.health", "health.settings.moduleHint", "help.profile.modules"],
    ["module.flowMaps", "flowMaps.settings.moduleHint"],
    ["module.planner", "plan.settings.moduleHint"],
    ["module.chatWatcher", "settings.modules.chatWatcherHint"],
    ["module.automations", "settings.modules.automationsHint"],
    ["nav.tickets", "settings.modules.ticketsHint"],
    ["settingsV2.screens.aiReview", "aiReview.settings.hint"],
  ]),
  ...profileRows(
    "screens",
    undefined,
    [
      ["prFilter.owners", "prFilter.ownersHint"],
      ["prFilter.exclude", "prFilter.excludeHint"],
    ],
    "pullRequests",
  ),
  ...profileRows(
    "screens",
    "trackers.list",
    [
      ["trackers.provider", undefined, "help.trackers.list"],
      ["trackers.site", "trackers.siteHint"],
      ["trackers.email"],
      ["trackers.projectKeys", "trackers.projectKeysHint"],
      ["trackers.ignoredStatuses", "trackers.ignoredStatusesHint"],
      ["trackers.useInProfile"],
    ],
    "tickets",
  ),
  ...profileRows(
    "screens",
    undefined,
    [["slack.archiveAfter", "slack.archiveAfterHint", "help.profile.slack"]],
    "slack",
  ),
  ...profileRows(
    "screens",
    "slack.settings.watcher",
    [
      [
        "slack.settings.enabled",
        "slack.settings.explain",
        "help.slack.watcher",
      ],
      ["slack.settings.account", undefined, "help.slack.account"],
      ["slack.settings.model", undefined, "help.slack.model"],
      ["slack.settings.interval", "slack.settings.intervalHint"],
      ["slack.settings.usage", "slack.settings.usageHint"],
      ["slack.settings.hours", undefined, "help.slack.hours"],
      ["slack.settings.channels"],
    ],
    "slack",
  ),
  ...profileRows(
    "screens",
    "slack.hook.title",
    [["slack.hook.title", undefined, "help.slack.hook"]],
    "slack",
  ),
  ...profileRows(
    "screens",
    "health.settings.connection",
    [
      [
        "health.settings.url",
        "health.settings.urlHint",
        "help.health.connection",
      ],
      ["health.settings.auth"],
      ["health.settings.tls", undefined, "help.health.tls"],
      ["health.settings.fingerprint", "health.settings.fingerprintHint"],
    ],
    "health",
  ),
  ...profileRows(
    "screens",
    "health.settings.environments",
    [
      ["health.settings.refresh", undefined, "help.health.environments"],
      ["health.settings.floor", "health.settings.floorHint"],
      ["health.settings.envName"],
      ["health.settings.indexErrors"],
      ["health.settings.indexTraces"],
      ["health.settings.indexMetrics"],
      ["health.settings.kibana", "health.settings.kibanaHint"],
      ["health.settings.kubeState", "health.settings.kubeStateHint"],
    ],
    "health",
  ),
  ...profileRows(
    "screens",
    "alertsSettings.health.title",
    [["alertsSettings.health.title", undefined, "alertsSettings.health.help"]],
    "health",
  ),
  ...profileRows(
    "screens",
    "alertsSettings.metrics.title",
    [
      [
        "metricAlerts.settings.notifyMin",
        "metricAlerts.settings.notifyMinHint",
        "alertsSettings.metrics.help",
      ],
      ["metricAlerts.settings.businessDays"],
    ],
    "health",
  ),
  ...profileRows(
    "screens",
    "alertsSettings.quiet.title",
    [["alertsSettings.quiet.on", undefined, "alertsSettings.quiet.help"]],
    "health",
  ),
  ...profileRows(
    "screens",
    "flowMaps.settings.folder",
    [
      ["flowMaps.settings.folder", "flowMaps.settings.folderHint"],
      ["flowMaps.settings.import", "flowMaps.settings.format"],
    ],
    "flowMaps",
  ),
  ...profileRows(
    "screens",
    "flowMaps.settings.list",
    [["flowMaps.settings.list"]],
    "flowMaps",
  ),
  ...profileRows(
    "screens",
    "plan.settings.calendars",
    [
      ["plan.settings.calendars", undefined, "plan.settings.calendarsHelp"],
      ["plan.settings.refresh", "plan.settings.refreshHint"],
      ["plan.settings.address", "plan.settings.addressHint"],
    ],
    "plan",
  ),
  ...profileRows(
    "screens",
    "plan.settings.reminders",
    [
      [
        "plan.settings.defaultLead",
        "plan.settings.defaultLeadHint",
        "plan.settings.remindersHelp",
      ],
      ["plan.settings.ruleName"],
      ["plan.settings.ruleMessage", "plan.settings.ruleMessageHint"],
    ],
    "plan",
  ),
  ...profileRows(
    "screens",
    "plan.settings.template",
    [["plan.settings.template", undefined, "plan.settings.templateHelp"]],
    "plan",
  ),
  ...profileRows(
    "screens",
    "plan.settings.people",
    [["plan.settings.people", undefined, "plan.settings.peopleHelp"]],
    "plan",
  ),
  ...profileRows(
    "screens",
    "planner.settings.inbox",
    [
      [
        "planner.settings.tracker",
        "planner.settings.trackerHint",
        "planner.settings.inboxHelp",
      ],
      ["planner.settings.project", "planner.settings.projectHint"],
      [
        "planner.settings.agentMilestones",
        "planner.settings.agentMilestonesHint",
      ],
    ],
    "plan",
  ),
  ...profileRows(
    "screens",
    undefined,
    [
      [
        "aiReview.settings.enabled",
        "aiReview.settings.hint",
        "help.profile.aiReview",
      ],
      ["aiReview.settings.auto"],
      ["aiReview.settings.reviewer", undefined, "help.aiReview.reviewer"],
      [
        "aiReview.settings.reviewerModel",
        "aiReview.settings.reviewerModelHint",
      ],
      [
        "aiReview.settings.reviewerEffort",
        "aiReview.settings.reviewerEffortHint",
      ],
      [
        "aiReview.settings.reviewerSession",
        "aiReview.settings.reviewerSessionHint",
      ],
      ["aiReview.settings.maxRounds", undefined, "help.aiReview.maxRounds"],
      ["aiReview.settings.idleSeconds", undefined, "help.aiReview.idleSeconds"],
      ["aiReview.settings.baseBranch", "aiReview.settings.baseBranchHint"],
      ["aiReview.settings.checklist", "aiReview.settings.checklistHint"],
      ["aiReview.settings.language"],
      ["aiReview.settings.briefPrompt"],
    ],
    "aiReview",
  ),

  // A profile › Agents
  ...profileRows("agents", "settingsV2.agentsTab.order", [
    [
      "settingsV2.agentsTab.order",
      "settings.agentOrderHint",
      "agents.orderHelp",
    ],
  ]),
  ...profileRows("agents", "settingsV2.agentsTab.failoverGroup", [
    [
      "settingsV2.agentsTab.failover",
      "continuity.settings.hint",
      "help.profile.accountFailover",
    ],
  ]),
  ...profileRows("agents", "settings.accountsList", [
    [
      "settings.accountsList",
      "settings.accountsOwnSignIn",
      "help.profile.accounts",
    ],
  ]),
  ...profileRows("agents", "settings.agentsOffered", [
    ["settings.allAgents", undefined, "help.profile.agentsOffered"],
  ]),

  // A profile › Sessions and links
  ...profileRows("sessions", "profileExtra.links", [
    ["profileExtra.linkBrowser", "profileExtra.linkBrowserHint"],
    ["settingsV2.profile.ownsOutside", "profileExtra.ownsOutsideHint"],
  ]),
  ...profileRows("sessions", "profileExtra.env", [
    ["profileExtra.env", undefined, "profileExtra.envHelp"],
  ]),

  // Advanced
  ...rows("advanced", "settingsV2.advanced.diagnostics", [
    ["setup.entry.check", "setup.entry.checkHint"],
    ["setup.entry.welcome", "setup.entry.welcomeHint"],
    ["setup.entry.help", "setup.entry.helpHint"],
  ]),
  ...rows("advanced", "settingsV2.advanced.data", [
    [
      "settingsV2.advanced.dataDir",
      "settingsV2.advanced.dataDirHint",
      "help.general.storage",
    ],
  ]),
  ...rows(
    "advanced",
    "settingsV2.advanced.data",
    [["import.migrate", "import.migrateHint", "help.general.import"]],
    { only: "workhub1" },
  ),
];

/** Lower case without accents, so "notificacion" finds "Notificación". */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export interface SettingsHit {
  entry: SettingsIndexEntry;
  /** Group › Section › (Tab › Screen ›) Subgroup, translated. */
  breadcrumb: string[];
  label: string;
  hint?: string;
}

export interface SearchOptions {
  /** The translated label of a key. */
  t: (key: MessageKey) => string;
  /** The translated heading of a navigation group. */
  groupLabel: (group: SettingsNavGroup) => string;
  /** Rows that do not show on this computer (the Workhub 1 import outside macOS) are left out. */
  visible?: (entry: SettingsIndexEntry) => boolean;
  limit?: number;
}

/** Where a row sits, translated: its group, section, profile tab and screen, and subgroup. */
export function entryBreadcrumb(
  entry: SettingsIndexEntry,
  { t, groupLabel }: Pick<SearchOptions, "t" | "groupLabel">,
): string[] | null {
  const meta = SETTINGS_SECTIONS.find((s) => s.id === entry.section);
  if (!meta) return null;
  const tab = entry.tab
    ? PROFILE_TABS.find((x) => x.id === entry.tab)
    : undefined;
  const screen = entry.screen ? PROFILE_SCREEN_LABEL[entry.screen] : undefined;
  return [
    groupLabel(meta.group),
    t(meta.label),
    ...(tab ? [t(tab.label)] : []),
    ...(screen && screen !== entry.label ? [t(screen)] : []),
    ...(entry.subgroup && entry.subgroup !== entry.label
      ? [t(entry.subgroup)]
      : []),
  ];
}

/**
 * The rows whose label, hint, help or headings contain every word of the query, compared without
 * case or accents in the active language. Label matches come first, then the index order.
 */
export function searchSettings(
  index: readonly SettingsIndexEntry[],
  query: string,
  { t, groupLabel, visible, limit = 40 }: SearchOptions,
): SettingsHit[] {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { hit: SettingsHit; score: number; order: number }[] = [];
  index.forEach((entry, order) => {
    if (visible && !visible(entry)) return;
    const breadcrumb = entryBreadcrumb(entry, { t, groupLabel });
    if (!breadcrumb) return;
    const label = entry.text ?? t(entry.label);
    const hint = entry.hint ? t(entry.hint) : undefined;
    const foldedLabel = foldText(label);
    const haystack = foldText(
      [label, hint ?? "", entry.help ? t(entry.help) : "", ...breadcrumb].join(
        " \u0000 ",
      ),
    );
    if (!words.every((w) => haystack.includes(w))) return;
    const score = words.every((w) => foldedLabel.includes(w))
      ? foldedLabel.startsWith(words[0]!)
        ? 0
        : 1
      : 2;
    scored.push({
      hit: { entry, breadcrumb, label, ...(hint ? { hint } : {}) },
      score,
      order,
    });
  });
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  // One result per row: a label repeated in a place (two groups both named "Accounts") shows once.
  const seen = new Set<string>();
  const out: SettingsHit[] = [];
  for (const { hit } of scored) {
    const key = hitKey(hit.entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

/** One key per place a row can be: section, tab, screen and label. */
export const hitKey = (entry: SettingsIndexEntry) =>
  [
    entry.section,
    entry.tab ?? "",
    entry.screen ?? "",
    entry.profileId ?? "",
    entry.label,
  ].join("\u0000");

/** One entry per profile, so a profile is found by its name and opens on its first tab. */
export const profileEntries = (
  profiles: readonly { id: string; name: string }[],
): SettingsIndexEntry[] =>
  profiles.map((p) => ({
    section: "profiles",
    tab: "folders",
    profileId: p.id,
    label: "settingsV2.nav.profiles",
    text: p.name || p.id,
  }));
