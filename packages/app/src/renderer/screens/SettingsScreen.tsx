import { TriangleAlert, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { ValidationIssue } from "@workhub/core";
import type { ConfigSnapshot, Platform } from "@shared/api";
import { Button } from "../components/atoms";
import { useToast } from "../components/molecules";
import { Workhub1SecretsImport } from "../components/organisms";
import {
  SaveBar,
  SAVE_SHORTCUT,
  StoreUnsavedPrompt,
  UnsavedChangesProvider,
} from "../components/organisms/UnsavedChanges";
import { refreshConfig } from "../configStore";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/translate";
import { cn } from "../lib/cn";
import {
  friendlyIssue,
  humanIssue,
  type IssueTarget,
} from "../lib/configIssues";
import { matchesShortcut } from "../lib/shortcuts";
import type { UnsavedChanges } from "../lib/unsavedChanges";
import {
  showWorkhub1Migration,
  showWorkhub1Tokens,
  useWorkhub1Preview,
} from "../lib/workhub1";
import { AccountsSection } from "./settings/AccountsSection";
import { ConnectionsSection } from "./settings/ConnectionsSection";
import { focusSettingGroup, focusSettingRow } from "./settings/focusRow";
import { NotificationsAlertsSection } from "./settings/NotificationsAlertsSection";
import { ProfilesSection, type OpenProfile } from "./settings/ProfilesSection";
import type { Run } from "./settings/run";
import {
  isProfileScreen,
  issueSection,
  issueTarget,
  sectionMeta,
  type ProfileScreen,
  type ProfileTab,
  type SettingsNavGroup,
  type SettingsSectionId,
  type SettingsTarget,
} from "./settings/sections";
import {
  hitKey,
  SETTINGS_INDEX,
  searchSettings,
  type SettingsHit,
  type SettingsIndexEntry,
} from "./settings/settings-index";
import { SettingsNav } from "./settings/SettingsNav";
import { Issues } from "./settings/shared";
import { AdvancedSection, GeneralSection } from "./settings/WorkhubSections";

/** The one-line description under each section's title. */
const INTRO: Record<SettingsSectionId, MessageKey> = {
  general: "settingsV2.intro.general",
  notifications: "settingsV2.intro.notifications",
  agents: "settingsAgents.intro",
  connections: "settingsConnections.intro",
  profiles: "settingsV2.intro.profiles",
  advanced: "settingsV2.intro.advanced",
};

const GROUP_LABEL: Record<SettingsNavGroup, MessageKey> = {
  app: "settingsV2.navGroup.app",
  profile: "settingsV2.navGroup.profile",
  advanced: "settings.navGroup.advanced",
};

/** A row (by its label) or a group (by its anchor) to bring into view once its section is on screen. */
interface PendingFocus {
  label?: string;
  group?: string;
  nonce: number;
}

/** A Settings group to point at: its `anchor` and when it was asked for (a new `at` points again). */
export interface SettingsSpotlight {
  group: string;
  at: number;
}

/** A profile to open from outside (a link, the menu bar): `id` absent is the active one; a new `at` asks again. */
export interface SettingsProfileRequest {
  id?: string;
  tab: ProfileTab;
  at: number;
}

export interface SettingsScreenProps {
  snap: ConfigSnapshot | null;
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  /** Closes Settings (Esc, and the header's close button when not in a window of its own); the caller asks `unsaved` first. */
  onClose: () => void;
  /** The drafts of every form here; asked before the section changes or the window closes. */
  unsaved: UnsavedChanges;
  /** Settings fills a window of its own on this platform: the header is its title bar (drag area, room for the window controls). */
  windowChrome?: Platform;
  /** Scroll to this group of the section and highlight it, dimming the others for a moment (`general#updates`). */
  spotlight?: SettingsSpotlight | null;
  /** Open this profile (on this tab) in Profiles (`profiles/acme/screens`, `openSettings('health')`). */
  profileRequest?: SettingsProfileRequest | null;
}

/** Settings as a screen: a header (with a close button only when embedded), the grouped navigation with search on the left, the section on the right. */
export function SettingsScreen(props: SettingsScreenProps) {
  return (
    <UnsavedChangesProvider store={props.unsaved}>
      <SettingsBody {...props} />
    </UnsavedChangesProvider>
  );
}

function SettingsBody({
  snap,
  section,
  onSectionChange,
  onClose,
  unsaved,
  windowChrome,
  spotlight,
  profileRequest,
}: SettingsScreenProps) {
  const { t } = useI18n();
  const notify = useToast();
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  // The item a "fix" button asked to open; the section's form starts on it.
  const [focus, setFocus] = useState<IssueTarget | null>(null);
  // The notification row a search hit asked for (that section points at it itself).
  const [rowId, setRowId] = useState<string | undefined>(undefined);
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null);
  const [query, setQuery] = useState("");
  const [activeHit, setActiveHit] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // Workhub 1 on this Mac (read again after every config change): drives the migration UI's visibility.
  const workhub1 = useWorkhub1Preview(snap?.config);

  const activeProfileId = snap?.config.activeProfileId ?? null;
  const profiles = snap?.config.profiles ?? [];
  /** The profile to open: the asked one, else the open one, else the active one, else the first. */
  const resolveProfile = (
    id: string | undefined,
    current: OpenProfile | null,
  ) => id ?? current?.id ?? activeProfileId ?? profiles[0]?.id ?? null;
  const [openProfile, setOpenProfile] = useState<OpenProfile | null>(() => {
    if (!profileRequest) return null;
    const id = resolveProfile(profileRequest.id, null);
    return id ? { id, tab: profileRequest.tab } : null;
  });
  // A screen of the Screens tab to open (`#health`, a search hit inside it).
  const [openScreen, setOpenScreen] = useState<{
    key: ProfileScreen;
    at: number;
  } | null>(() =>
    spotlight && isProfileScreen(spotlight.group)
      ? { key: spotlight.group, at: spotlight.at }
      : null,
  );

  // A deleted (or unknown) profile goes back to the list; a request made before the config loaded opens now.
  useEffect(() => {
    if (!snap) return;
    if (openProfile?.id && !profiles.some((p) => p.id === openProfile.id))
      setOpenProfile(null);
    else if (
      !openProfile &&
      profileRequest &&
      lastRequest.current === undefined
    ) {
      lastRequest.current = profileRequest.at;
      const id = resolveProfile(profileRequest.id, null);
      if (id && profiles.some((p) => p.id === id))
        setOpenProfile({ id, tab: profileRequest.tab });
    }
  }, [profiles, openProfile, snap]); // eslint-disable-line react-hooks/exhaustive-deps

  // A profile asked for from outside while Settings was already open.
  const lastRequest = useRef<number | undefined>(
    snap ? profileRequest?.at : undefined,
  );
  useEffect(() => {
    if (!snap || !profileRequest || profileRequest.at === lastRequest.current)
      return;
    lastRequest.current = profileRequest.at;
    const id = resolveProfile(profileRequest.id, null);
    setOpenProfile(id ? { id, tab: profileRequest.tab } : null);
  }, [profileRequest, snap]); // eslint-disable-line react-hooks/exhaustive-deps

  const run: Run = async (op) => {
    const r = await op();
    if (!r.ok) {
      setIssues(r.issues);
      const first = r.issues[0];
      unsaved.reportProblem(
        first ? friendlyIssue(first, (k, p) => t(k, p)) : null,
      );
      return false;
    }
    setIssues([]);
    unsaved.reportProblem(null);
    // A save from the save bar says "Saved" there; a switch that saves at once says it here.
    if (!unsaved.snapshot().saving) notify(t("settings.saved"));
    await refreshConfig();
    return true;
  };

  const editable = snap ? !snap.loadError : false;
  const importVisible =
    editable && showWorkhub1Migration(window.hub.platform, workhub1);
  const visible = (entry: SettingsIndexEntry) =>
    entry.only !== "workhub1" || importVisible;
  const groupLabel = (group: SettingsNavGroup) => t(GROUP_LABEL[group]);
  const hits = useMemo(
    () => searchSettings(SETTINGS_INDEX, query, { t, groupLabel, visible }),
    [query, t, importVisible],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setActiveHit(0), [query]);

  // Sections with a stored-config problem get a dot in the navigation.
  const withIssues = useMemo(() => {
    const out = new Set<SettingsSectionId>();
    for (const i of snap?.issues ?? []) {
      const target = snap
        ? humanIssue(i, snap.config, snap.providers, (k) => t(k)).action?.target
        : undefined;
      if (target) out.add(issueSection(target));
    }
    return out;
  }, [snap, t]);

  // Once the asked-for section is on screen, bring the row into view (sections that load their data render late).
  useEffect(() => {
    if (!pendingFocus) return;
    let tries = 0;
    let timer = 0;
    const attempt = () => {
      const found = pendingFocus.group
        ? focusSettingGroup(content.current, pendingFocus.group)
        : focusSettingRow(content.current, pendingFocus.label ?? "");
      if (found || ++tries > 10) return setPendingFocus(null);
      timer = window.setTimeout(attempt, 100);
    };
    timer = window.setTimeout(attempt, 50);
    return () => window.clearTimeout(timer);
  }, [pendingFocus, section, openProfile]);

  // A `section#anchor` target (the menu bar's "Check for updates…"): point at the group once it shows.
  useEffect(() => {
    if (!spotlight) return;
    if (isProfileScreen(spotlight.group))
      setOpenScreen({ key: spotlight.group, at: spotlight.at });
    setPendingFocus({ group: spotlight.group, nonce: spotlight.at });
  }, [spotlight]);

  /** Goes to a place (a section, a profile and its tab, a group); the drafts are asked about first. */
  const navigate = (
    target: SettingsTarget,
    opts: {
      focus?: IssueTarget | null;
      label?: string;
      screen?: ProfileScreen;
      rowId?: string;
    } = {},
  ) =>
    unsaved.requestLeave(() => {
      const now = Date.now();
      setIssues([]);
      setFocus(opts.focus ?? null);
      setRowId(opts.rowId);
      setQuery("");
      onSectionChange(target.section);
      if (target.profile) {
        const id = resolveProfile(target.profile.id, openProfile);
        setOpenProfile(id ? { id, tab: target.profile.tab } : null);
      } else setOpenProfile(null);
      const screen =
        opts.screen ??
        (isProfileScreen(target.group) ? target.group : undefined);
      if (screen) setOpenScreen({ key: screen, at: now });
      if (opts.label) setPendingFocus({ label: opts.label, nonce: now });
      else if (target.group)
        setPendingFocus({ group: target.group, nonce: now });
      content.current?.scrollTo({ top: 0 });
    });
  const fix = (target: IssueTarget) =>
    navigate(issueTarget(target), { focus: target });
  const openHit = (hit: SettingsHit) => {
    const { entry } = hit;
    const label = entry.focus ? t(entry.focus) : hit.label;
    // These sections highlight their own rows by id.
    if (
      entry.section === "notifications" ||
      entry.section === "agents" ||
      entry.section === "connections"
    )
      return navigate(
        { section: entry.section },
        { label, ...(entry.id ? { rowId: entry.id } : {}) },
      );
    // A row of a profile opens the open profile (else the active one) on its tab.
    const target: SettingsTarget = entry.tab
      ? { section: "profiles", profile: { tab: entry.tab } }
      : { section: entry.section };
    navigate(target, {
      label,
      ...(entry.screen ? { screen: entry.screen } : {}),
    });
  };
  const openProfileAt = (next: OpenProfile | null, direct = false) => {
    const apply = () => {
      setIssues([]);
      setFocus(null);
      setOpenProfile(next);
      content.current?.scrollTo({ top: 0 });
    };
    if (direct) apply();
    else unsaved.requestLeave(apply);
  };

  // ⌘F searches, Esc clears the search and then closes Settings; ⌘S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, { key: "f" }, window.hub.platform)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (matchesShortcut(e, SAVE_SHORTCUT, window.hub.platform)) {
        e.preventDefault();
        if (unsaved.snapshot().dirty) void unsaved.saveAll();
        return;
      }
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A menu, list or dialog open over Settings closes first.
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]',
        )
      )
        return;
      e.preventDefault();
      if (query) setQuery("");
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query, onClose, unsaved]);

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActiveHit((i) =>
        hits.length
          ? (i + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length
          : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[activeHit];
      if (hit) openHit(hit);
    } else if (e.key === "Escape" && query) {
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    }
  };

  if (!snap) return null;
  const meta = sectionMeta(section);
  const focusId = (...tabs: IssueTarget["tab"][]) =>
    focus && tabs.includes(focus.tab) ? focus.id : undefined;
  const sectionKey = `${section}:${focus?.tab ?? ""}:${focus?.id ?? ""}`;
  const shownProfile = section === "profiles" ? openProfile : null;
  const editedProfile = shownProfile?.id
    ? profiles.find((p) => p.id === shownProfile.id)
    : undefined;

  const body = (): ReactNode => {
    switch (section) {
      case "general":
        return <GeneralSection snap={snap} run={run} />;
      case "notifications":
        return (
          <NotificationsAlertsSection
            snap={snap}
            run={run}
            initialId={rowId}
            platform={window.hub.platform}
            onOpenProfile={(id, tab) =>
              navigate({ section: "profiles", profile: { id, tab } })
            }
          />
        );
      case "agents":
        return (
          <AccountsSection
            snap={snap}
            run={run}
            initialId={focusId("accounts") ?? rowId}
          />
        );
      case "connections":
        return (
          <ConnectionsSection
            snap={snap}
            run={run}
            initialId={focusId("connections", "trackers") ?? rowId}
          />
        );
      case "profiles":
        return (
          <ProfilesSection
            snap={snap}
            run={run}
            open={shownProfile}
            onOpen={openProfileAt}
            onTab={(tab) => setOpenProfile((o) => (o ? { ...o, tab } : o))}
            openScreen={openScreen}
            focusHealthSecret={focus?.tab === "health"}
          />
        );
      case "advanced":
        return (
          <AdvancedSection
            snap={snap}
            run={run}
            workhub1={workhub1}
            importVisible={importVisible}
          />
        );
    }
  };

  const title = shownProfile
    ? `${t(meta.label)} › ${editedProfile ? editedProfile.name || editedProfile.id : t("settings.newProfile")}`
    : t(meta.label);

  return (
    <div
      ref={root}
      className="flex h-full flex-col"
      data-testid="settings-screen"
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-3 border-b border-border px-6 py-3",
          windowChrome && "drag-region",
          windowChrome === "mac" && "pl-20",
          windowChrome && windowChrome !== "mac" && "pr-36",
        )}
      >
        <h1 className="min-w-0 flex-1 text-2xl font-semibold tracking-tight">
          {t("nav.settings")}
        </h1>
        {/* In a window of its own the OS title bar already closes it (and Esc does); the in-app ✕ is only for an embedded Settings. */}
        {!windowChrome && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
            data-testid="settings-close"
            className="rounded-md p-1.5 text-muted hover:bg-surface-hover hover:text-text"
          >
            <X className="size-5" aria-hidden />
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        <SettingsNav
          section={section}
          onSection={(s) => navigate({ section: s })}
          withIssues={withIssues}
          profiles={profiles}
          activeProfileId={activeProfileId}
          openProfileId={shownProfile ? shownProfile.id : undefined}
          onProfile={(id) =>
            navigate({
              section: "profiles",
              profile: { id, tab: shownProfile?.tab ?? "folders" },
            })
          }
          query={query}
          onQuery={setQuery}
          onSearchKey={onSearchKey}
          searchRef={searchRef}
          groupLabel={groupLabel}
        />
        <div
          ref={content}
          className="min-h-0 flex-1 [scrollbar-gutter:stable] overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-8 py-6">
            {snap.loadError && (
              <Issues
                title={t("settings.loadError")}
                issues={[{ path: "config.json", message: snap.loadError }]}
              />
            )}
            <StoredIssues snap={snap} onFix={fix} />
            {showWorkhub1Tokens(window.hub.platform, workhub1) && (
              <div className="rounded-lg border border-border bg-surface px-4 py-3 shadow-sm">
                <Workhub1SecretsImport compact />
              </div>
            )}
            {query && (
              <SearchResults
                hits={hits}
                query={query}
                active={activeHit}
                onOpen={openHit}
              />
            )}
            {/* Hidden, not unmounted, while searching: a draft in the section survives a search. */}
            <section
              className={query ? "hidden" : "flex flex-col gap-4"}
              aria-labelledby="settings-section-title"
            >
              <div className="flex flex-col gap-1">
                <h2
                  id="settings-section-title"
                  className="text-xl font-semibold tracking-tight"
                >
                  {title}
                </h2>
                {!shownProfile && (
                  <p className="max-w-3xl text-base text-muted">
                    {t(INTRO[section])}
                  </p>
                )}
              </div>
              <Issues issues={issues} />
              <div key={sectionKey}>{body()}</div>
            </section>
          </div>
        </div>
      </div>
      <SaveBar store={unsaved} />
      <StoreUnsavedPrompt
        store={unsaved}
        restoreFocus={() => root.current?.focus()}
      />
    </div>
  );
}

/** The search's matches: breadcrumb, label and hint; a click (or Enter) opens the row. */
function SearchResults({
  hits,
  query,
  active,
  onOpen,
}: {
  hits: SettingsHit[];
  query: string;
  active: number;
  onOpen: (hit: SettingsHit) => void;
}) {
  const { t } = useI18n();
  if (!hits.length)
    return (
      <p
        className="py-6 text-center text-base text-muted"
        data-testid="settings-search-empty"
      >
        {t("settings.search.empty", { query })}
      </p>
    );
  return (
    <section
      aria-label={t("settings.search.results")}
      className="flex flex-col gap-1"
      data-testid="settings-search-results"
    >
      <h2 className="px-1 text-md font-semibold">
        {t("settings.search.results")}
      </h2>
      <ul className="flex flex-col gap-1">
        {hits.map((hit, i) => (
          <li key={hitKey(hit.entry)}>
            <button
              type="button"
              onClick={() => onOpen(hit)}
              aria-current={i === active ? "true" : undefined}
              className={`flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left ${i === active ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-hover"}`}
            >
              <span className="text-xs text-subtle">
                {hit.breadcrumb.join(" › ")}
              </span>
              <span className="text-base text-text">{hit.label}</span>
              {hit.hint && (
                <span className="line-clamp-2 text-xs text-muted">
                  {hit.hint}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The stored config's problems in plain words, each with a button to the section that fixes it. */
function StoredIssues({
  snap,
  onFix,
}: {
  snap: ConfigSnapshot;
  onFix: (target: IssueTarget) => void;
}) {
  const { t } = useI18n();
  if (!snap.issues.length) return null;
  const items = snap.issues.map((i) =>
    humanIssue(i, snap.config, snap.providers, (k) => t(k)),
  );
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3"
      data-testid="stored-issues"
    >
      <TriangleAlert
        className="mt-0.5 size-4 shrink-0 text-warning"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold text-text">{t("issues.title")}</p>
        <ul className="mt-1 flex flex-col gap-1.5">
          {items.map((i) => (
            <li
              key={i.key}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-base text-text"
              title={i.technical}
            >
              <span className="min-w-0">{t(i.message, i.params)}</span>
              {i.action && (
                <Button size="sm" onClick={() => onFix(i.action!.target)}>
                  {t(i.action.label)}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
