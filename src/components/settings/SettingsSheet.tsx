import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { GroupRule, Switch } from "@/components/ui/Form";
import { Segmented } from "@/components/ui/Segmented";
import { FONT_SCALES, type TabBehaviour, type Theme } from "@/lib/prefs";
import { SUPPORT_NOTE } from "@/lib/security";
import { findEnvironment } from "@/lib/utils/environments";
import { asDbError } from "@/lib/utils/errors";
import { useApp } from "@/store/app";

type Section = "appearance" | "behaviour" | "security";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "behaviour", label: "Behaviour" },
  { id: "security", label: "Security" },
];

/**
 * A theme, drawn as the app rather than named as a word.
 *
 * Everything inside sits under `data-theme`, so it paints from the same tokens
 * the real window does. That is the whole reason `theme.css` resolves its
 * colours through a second layer of variables: a tile built from a copied list
 * of hex values is a tile that is wrong the first time a colour is tuned, and
 * wrong in the one place whose only job is to show what the colour is.
 *
 * The shapes are the app's own: the titlebar strip, the sidebar column, the
 * grid with one selected cell. A user picking a palette is picking what a
 * result set looks like at 11pm, and no swatch answers that.
 */
function ThemeTile({ theme }: { theme: Theme }) {
  return (
    <div
      data-theme={theme}
      aria-hidden="true"
      className="flex h-[84px] flex-col overflow-hidden rounded bg-base"
    >
      {/* Titlebar: traffic lights and one active tab. */}
      <div className="flex h-3.5 shrink-0 items-end gap-1 border-b border-line-soft bg-raised px-1.5 pb-px">
        <span className="mb-[3px] size-1 rounded-full bg-ink-faint/70" />
        <span className="mb-[3px] size-1 rounded-full bg-ink-faint/70" />
        <span className="mb-[3px] mr-1 size-1 rounded-full bg-ink-faint/70" />
        <span className="h-2.5 w-8 rounded-t-sm border-t border-accent bg-base" />
        <span className="h-2.5 w-6 rounded-t-sm bg-raised" />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar. */}
        <div className="flex w-[30px] shrink-0 flex-col gap-1 border-r border-line-soft bg-raised px-1.5 py-1.5">
          <span className="h-1 w-full rounded-full bg-ink-faint/50" />
          <span className="h-1 w-4/5 rounded-full bg-ink-faint/35" />
          <span className="h-1 w-full rounded-full bg-accent-wash" />
          <span className="h-1 w-3/5 rounded-full bg-ink-faint/35" />
        </div>

        {/* Grid: header, zebra rows, one selected cell. */}
        <div className="flex min-w-0 flex-1 flex-col bg-canvas">
          <div className="flex h-2.5 shrink-0 items-center gap-1 border-b border-line px-1.5">
            <span className="h-0.5 w-5 rounded-full bg-ink-faint/60" />
            <span className="h-0.5 w-7 rounded-full bg-ink-faint/60" />
            <span className="h-0.5 w-4 rounded-full bg-ink-faint/60" />
          </div>
          {[0, 1, 2, 3].map((row) => (
            <div
              key={row}
              className={[
                "flex h-2.5 shrink-0 items-center gap-1 px-1.5",
                row % 2 === 1 ? "bg-row-alt" : "",
              ].join(" ")}
            >
              <span className="h-0.5 w-5 rounded-full bg-num/80" />
              {row === 1 ? (
                <span className="h-2 w-7 rounded-[1px] border border-accent bg-accent-wash" />
              ) : (
                <span className="h-0.5 w-7 rounded-full bg-str/70" />
              )}
              <span className="h-0.5 w-4 rounded-full bg-ink-muted/70" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * What the next opened table does to the tab strip.
 *
 * Two bars and a third that either arrives or replaces: the difference between
 * the two settings is a thing that happens to a row of tabs, and a row of tabs
 * is small enough to just draw.
 */
function TabDiagram({ behaviour }: { behaviour: TabBehaviour }) {
  return (
    <div aria-hidden="true" className="flex h-3.5 shrink-0 items-end gap-px">
      <span className="h-2.5 w-6 rounded-t-sm bg-field" />
      {behaviour === "new" ? (
        <>
          <span className="h-2.5 w-6 rounded-t-sm bg-field" />
          <span className="h-3 w-6 rounded-t-sm border-t border-accent bg-accent-wash" />
        </>
      ) : (
        <>
          <span className="h-3 w-6 rounded-t-sm border-t border-accent bg-accent-wash" />
          {/* The space the third tab would have taken, left empty on purpose. */}
          <span className="h-2.5 w-6 rounded-t-sm border border-dashed border-line" />
        </>
      )}
    </div>
  );
}

/** One of two mutually exclusive settings that each need a sentence and a picture. */
function ChoiceRow({
  title,
  hint,
  chosen,
  onChoose,
  children,
}: {
  title: string;
  hint: string;
  chosen: boolean;
  onChoose: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      onClick={onChoose}
      className={[
        "flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left",
        // No border on the unchosen one. A ring that appears and disappears
        // moves the text beside it; a background that changes does not.
        chosen ? "bg-hover" : "hover:bg-hover/60",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "mt-0.5 size-3 shrink-0 rounded-full border",
          chosen ? "border-accent bg-accent-wash" : "border-line",
        ].join(" ")}
      >
        {chosen && <span className="m-[3px] block size-1 rounded-full bg-accent" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-[12px] ${chosen ? "text-ink" : "text-ink-muted"}`}>
          {title}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">{hint}</span>
      </span>
      {children}
    </button>
  );
}

/** A row that names a preference on the left and carries its control on the right. */
function SettingRow({
  label,
  hint,
  id,
  children,
}: {
  label: string;
  hint?: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 py-1.5">
      <div className="min-w-0 flex-1">
        <span id={id} className="block text-[12px] text-ink">
          {label}
        </span>
        {hint && <p className="mt-0.5 text-[11px] leading-snug text-ink-faint">{hint}</p>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

export function SettingsSheet() {
  const open = useApp((s) => s.settings);
  const setSettings = useApp((s) => s.setSettings);
  const prefs = useApp((s) => s.prefs);
  const setPrefs = useApp((s) => s.setPrefs);
  const translucent = useApp((s) => s.translucent);
  const toggleTranslucency = useApp((s) => s.toggleTranslucency);
  const security = useApp((s) => s.security);
  const biometrics = useApp((s) => s.biometrics);
  const setSecurity = useApp((s) => s.setSecurity);
  const setConnectionBiometric = useApp((s) => s.setConnectionBiometric);
  const connections = useApp((s) => s.connections);

  const [section, setSection] = useState<Section>("appearance");
  /** A refused Touch ID prompt on the way to writing the policy. */
  const [error, setError] = useState<string | null>(null);

  /** Linux has no compositor effect to switch on; the switch would do nothing. */
  const translucencySupported =
    typeof navigator !== "undefined" && /Macintosh|Mac OS X|Windows/.test(navigator.userAgent);

  async function writePolicy(patch: Parameters<typeof setSecurity>[0]) {
    setError(null);
    try {
      await setSecurity(patch);
    } catch (e) {
      // Turning the lock *off* is authenticated, so a refusal here is expected
      // and belongs beside the switch that sprang back rather than in a toast
      // over a sheet the user is still reading.
      setError(asDbError(e).message);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setSettings}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay-anim fixed inset-0 z-40 bg-scrim/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className={[
            "sheet-anim fixed top-1/2 left-1/2 z-50 flex h-[min(560px,86vh)] w-[min(720px,94vw)]",
            "-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-line",
            "bg-sheet shadow-2xl shadow-black/60",
          ].join(" ")}
        >
          {/* The rail. A 1px line and nothing else divides it from the pane —
              two panels, one border, which is how every other split in this
              app is drawn. */}
          <nav className="flex w-[164px] shrink-0 flex-col gap-px border-r border-line-soft p-2">
            <Dialog.Title className="px-2 pt-1 pb-2 text-[13px] font-semibold text-ink">
              Settings
            </Dialog.Title>
            {SECTIONS.map((s) => {
              const here = s.id === section;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSection(s.id)}
                  aria-current={here || undefined}
                  className={[
                    "rounded px-2 py-1 text-left text-[12px]",
                    // No motion. Moving between three sections is navigation,
                    // done repeatedly, and a transition on it reads as lag.
                    here ? "bg-hover text-ink" : "text-ink-muted hover:text-ink",
                  ].join(" ")}
                >
                  {s.label}
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {section === "appearance" && (
              <>
                <GroupRule label="Theme" id="s-theme" />
                <div
                  role="radiogroup"
                  aria-labelledby="s-theme"
                  className="mt-2 grid grid-cols-2 gap-3"
                >
                  {(["dark", "light"] as const).map((theme) => {
                    const on = prefs.theme === theme;
                    return (
                      <button
                        key={theme}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => setPrefs({ theme })}
                        className={[
                          "rounded-lg border p-1 text-left",
                          on ? "border-accent" : "border-line hover:border-line/60",
                        ].join(" ")}
                      >
                        <ThemeTile theme={theme} />
                        <span
                          className={`mt-1.5 mb-0.5 block px-1 text-[11px] ${on ? "text-ink" : "text-ink-muted"}`}
                        >
                          {theme === "dark" ? "Dark" : "Light"}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <GroupRule label="Text size" id="s-size" />
                <div className="mt-2">
                  <Segmented
                    label="Text size"
                    value={String(prefs.fontScale)}
                    options={FONT_SCALES.map((scale, i) => ({
                      value: String(scale),
                      label: ["Compact", "Default", "Large", "Larger"][i]!,
                    }))}
                    onChange={(value) => setPrefs({ fontScale: Number(value) })}
                  />
                  {/* A specimen, not a preview: the whole window has already
                      moved by the time this is read, and this is the piece of
                      it the size is actually chosen for. */}
                  <div className="mt-3 overflow-hidden rounded-md border border-line-soft">
                    <div className="flex h-7 items-center gap-4 border-b border-line bg-raised px-2 text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
                      <span className="w-10">id</span>
                      <span className="flex-1">email</span>
                      <span className="w-24">created_at</span>
                    </div>
                    {[
                      ["1042", "ada@example.com", "2026-08-19"],
                      ["1043", "grace@example.com", "2026-08-20"],
                    ].map(([id, email, created], row) => (
                      <div
                        key={id}
                        className={[
                          "flex h-6 items-center gap-4 px-2 font-mono text-[12px]",
                          row === 1 ? "bg-row-alt" : "bg-canvas",
                        ].join(" ")}
                      >
                        <span className="w-10 text-right text-num tabular-nums">{id}</span>
                        <span
                          className={[
                            "flex-1 truncate text-str",
                            row === 0 ? "-mx-0.5 rounded-[2px] bg-accent-wash px-0.5" : "",
                          ].join(" ")}
                        >
                          {email}
                        </span>
                        <span className="w-24 text-ink-muted">{created}</span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] leading-snug text-ink-faint">
                    Scales the whole window. The tab strip keeps its size, because the traffic
                    lights beside it are placed by the system and do not scale with a preference.
                  </p>
                </div>

                <GroupRule label="Window" id="s-window" />
                <SettingRow
                  id="s-translucency"
                  label="Translucency"
                  hint={
                    translucencySupported
                      ? "Lets the desktop through the titlebar, sidebar and status bar. The grid and the editor never take part."
                      : "No compositor effect is available on this platform, so every surface paints solid."
                  }
                >
                  <Switch
                    checked={translucent && translucencySupported}
                    onChange={() => translucencySupported && toggleTranslucency()}
                    labelledBy="s-translucency"
                  />
                </SettingRow>
              </>
            )}

            {section === "behaviour" && (
              <>
                <GroupRule label="Opening a table" id="s-tabs" />
                <div role="radiogroup" aria-labelledby="s-tabs" className="mt-1 flex flex-col">
                  <ChoiceRow
                    title="Always open in a new tab"
                    hint="Every table you open adds a tab. Nothing already open is disturbed."
                    chosen={prefs.tabBehaviour === "new"}
                    onChoose={() => setPrefs({ tabBehaviour: "new" })}
                  >
                    <TabDiagram behaviour="new" />
                  </ChoiceRow>
                  <ChoiceRow
                    title="Reuse the idle tab"
                    hint="The tab you are on is replaced, unless it has something unfinished: a filter, staged deletions, picked rows, a running query, typed SQL, a pin, or the other half of a split."
                    chosen={prefs.tabBehaviour === "idle"}
                    onChoose={() => setPrefs({ tabBehaviour: "idle" })}
                  >
                    <TabDiagram behaviour="idle" />
                  </ChoiceRow>
                </div>
              </>
            )}

            {section === "security" && (
              <>
                <GroupRule label="Touch ID" id="s-touchid" />

                {biometrics !== "available" ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
                    {SUPPORT_NOTE[biometrics]}
                  </p>
                ) : (
                  <>
                    <SettingRow
                      id="s-lock"
                      label="Require Touch ID when the app opens"
                      hint="Holds the window behind a prompt at launch."
                    >
                      <Switch
                        checked={security.lockOnLaunch}
                        onChange={(on) => void writePolicy({ lockOnLaunch: on })}
                        labelledBy="s-lock"
                      />
                    </SettingRow>

                    <SettingRow
                      id="s-all"
                      label="Require Touch ID for every connection"
                      hint="Asks before any connection opens, whatever the list below says. One confirmation covers the next five minutes, so switching database does not ask again."
                    >
                      <Switch
                        checked={security.requireForAllConnections}
                        onChange={(on) => void writePolicy({ requireForAllConnections: on })}
                        labelledBy="s-all"
                      />
                    </SettingRow>

                    {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}

                    <GroupRule label="Per connection" />
                    {connections.length === 0 ? (
                      <p className="mt-2 text-[11px] text-ink-faint">
                        No connections saved yet.
                      </p>
                    ) : (
                      <div
                        className={[
                          "mt-2 divide-y divide-line-soft overflow-hidden rounded-md border border-line-soft",
                          // Greyed rather than hidden when the switch above has
                          // already answered for all of them: the list still
                          // says what each connection is set to, which is worth
                          // reading even when it cannot be changed.
                          security.requireForAllConnections ? "pointer-events-none opacity-40" : "",
                        ].join(" ")}
                      >
                        {connections.map((c) => {
                          const env = findEnvironment(c.environment);
                          return (
                            <div key={c.id} className="flex items-center gap-2.5 px-2.5 py-1.5">
                              <span
                                aria-hidden="true"
                                className={`size-1.5 shrink-0 rounded-full ${env ? env.dot : "bg-ink-faint/40"}`}
                              />
                              <span className="min-w-0 flex-1">
                                <span
                                  id={`s-conn-${c.id}`}
                                  className="block truncate text-[12px] text-ink"
                                >
                                  {c.name || `${c.user}@${c.host}`}
                                </span>
                                <span className="block truncate font-mono text-[10px] text-ink-faint">
                                  {c.user}@{c.host}:{c.port}
                                </span>
                              </span>
                              <Switch
                                checked={security.requireForAllConnections || c.requireBiometric}
                                onChange={(on) => void setConnectionBiometric(c.id, on)}
                                labelledBy={`s-conn-${c.id}`}
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* The boundary, stated where it is offered rather than only
                        in the docs. */}
                    <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
                      This gates this app's own windows. It does not encrypt anything: passwords
                      stay in the system keychain, readable by Rashbase Studio without a
                      fingerprint, and <code className="font-mono">connections.json</code> is
                      readable by anything with access to your files.
                    </p>
                  </>
                )}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
