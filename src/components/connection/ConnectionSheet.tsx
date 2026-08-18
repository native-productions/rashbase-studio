import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";
import { useApp } from "@/store/app";
import { ipc } from "@/lib/ipc";
import { Select } from "@/components/ui/Select";
import { ENVIRONMENTS } from "@/lib/constants/environments";
import { BLANK_CONNECTION, BLANK_SSH, DRIVERS, driverSpec } from "@/lib/constants/connection";
import { INPUT_CLS } from "@/lib/constants/ui";
import { asDbError } from "@/lib/utils/errors";
import {
  forDriver,
  parseConnectionString,
  sslModeThroughTunnel,
  tildePath,
} from "@/lib/utils/connections";
import { findEnvironment } from "@/lib/utils/environments";
import type { ConnectionConfig, SshAuth, SshConfig, SslMode } from "@/lib/types";

/**
 * One row of the form: a label in the left column, a control in the right.
 *
 * Fragments rather than a wrapper, so every label and every control is a direct
 * child of the one grid that runs the whole form. That is what holds the two
 * columns to the same edge down the page, through a section the tunnel adds and
 * a hint that only some rows carry. A wrapper per row cannot do it: each row
 * would align only against itself.
 *
 * `id` ties the label to the control it names. Pass `labelId` instead when the
 * control is a group of buttons, which cannot be labelled by `for`.
 */
function Row({
  label,
  id,
  labelId,
  hint,
  children,
}: {
  label: string;
  id?: string;
  labelId?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      {labelId ? (
        <span id={labelId} className="justify-self-end text-[11px] text-ink-muted">
          {label}
        </span>
      ) : (
        <label htmlFor={id} className="justify-self-end text-[11px] text-ink-muted">
          {label}
        </label>
      )}
      <div className="min-w-0">{children}</div>
      {/* Its own row rather than tucked under the control, so the label beside
          the control stays vertically centred on it. */}
      {hint && (
        <p className="col-start-2 -mt-0.5 text-[10px] leading-snug text-ink-muted">{hint}</p>
      )}
    </>
  );
}

/** The rule that starts a group, with room for a control that governs it. */
function GroupRule({ label, id, children }: { label: string; id?: string; children?: React.ReactNode }) {
  return (
    <div className="col-span-2 mt-1 flex h-7 items-center gap-3 border-t border-line-soft pt-3">
      <span id={id} className="label-eyebrow">
        {label}
      </span>
      {children && <div className="ml-auto flex items-center gap-3">{children}</div>}
    </div>
  );
}

/**
 * On/off for a whole section of the form.
 *
 * Only the thumb moves, and only by transform: the track's colour flips on the
 * same frame as the click, because a colour that fades is a control that looks
 * like it is still deciding.
 */
function Switch({
  checked,
  onChange,
  labelledBy,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  labelledBy: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      onClick={() => onChange(!checked)}
      className={[
        "pressable h-4 w-7 shrink-0 rounded-full border p-0",
        "focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent",
        checked ? "border-accent bg-accent" : "border-transparent bg-field hover:bg-field-hover",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "block size-2.5 rounded-full duration-150 ease-[var(--ease-out-quart)] transition-transform",
          checked ? "translate-x-[13px] bg-canvas" : "translate-x-[2px] bg-ink-faint",
        ].join(" ")}
      />
    </button>
  );
}

/**
 * One choice out of a handful, as one track rather than a row of buttons.
 *
 * Extracted because the sheet now has two of these — the driver and the
 * environment — and two hand-rolled copies is how the second one ends up a
 * pixel off the first. No motion: the tint flips on the same frame as the
 * click, because a colour that fades is a control that looks like it is still
 * deciding.
 */
function Segmented({
  labelledBy,
  options,
  children,
}: {
  labelledBy: string;
  options: { id: string }[];
  children: (option: { id: string }, index: number) => React.ReactNode;
}) {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className="flex h-7 items-center gap-0.5 rounded-md bg-canvas p-0.5"
    >
      {options.map((option, i) => children(option, i))}
    </div>
  );
}

/** What the two SSH methods are called where the user can see them. */
const SSH_AUTH_LABEL: Record<SshAuth, string> = {
  key: "Private key",
  password: "Password",
};

export function ConnectionSheet() {
  const sheet = useApp((s) => s.sheet);
  const setSheet = useApp((s) => s.setSheet);
  const saveConnection = useApp((s) => s.saveConnection);
  const deleteConnection = useApp((s) => s.deleteConnection);
  const connect = useApp((s) => s.connect);

  const [form, setForm] = useState<ConnectionConfig>(BLANK_CONNECTION);
  const [password, setPassword] = useState("");
  /** The key's passphrase or the jump host's password, depending on `ssh.auth`. */
  const [sshSecret, setSshSecret] = useState("");
  const [connString, setConnString] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editing = !!sheet.editing;
  const ssh = form.ssh;
  /** Everything the form varies by driver, read from one place. */
  const spec = driverSpec(form.driver);
  /**
   * Drives the sheet's own colour, not just the label's.
   *
   * A connection form is the last screen before a session opens, and the one
   * field on it that decides how much damage a typo can do is the environment.
   * Colouring the edge and the head of the sheet puts that answer in peripheral
   * vision for the whole time the form is being filled in, rather than in one
   * dot the user chose ten seconds ago and has since scrolled past.
   *
   * Matched by prefix, so a connection saved back when the label was free text
   * ("prod") is coloured like the one that says "production".
   */
  const env = findEnvironment(form.environment);

  useEffect(() => {
    if (!sheet.open) return;
    setForm(sheet.editing ?? { ...BLANK_CONNECTION, id: crypto.randomUUID() });
    setPassword("");
    setSshSecret("");
    setConnString("");
    setError(null);
    setTested(null);
  }, [sheet.open, sheet.editing]);

  const patch = (p: Partial<ConnectionConfig>) => setForm((f) => ({ ...f, ...p }));

  const patchSsh = (p: Partial<SshConfig>) =>
    setForm((f) => (f.ssh ? { ...f, ssh: { ...f.ssh, ...p } } : f));

  /**
   * Turning the tunnel on also moves the SSL mode when it was a verifying one.
   * Through a tunnel the driver dials `127.0.0.1`, which is never the name on
   * the server's certificate, so `verify-full` fails with a hostname mismatch
   * that reads like a broken certificate. Moving it here, where the cause is
   * on screen, beats failing later where it is not.
   */
  function toggleSsh(on: boolean) {
    setForm((f) => ({
      ...f,
      ssh: on ? (f.ssh ?? { ...BLANK_SSH, user: f.user }) : null,
      sslMode: on ? sslModeThroughTunnel(f.sslMode) : f.sslMode,
    }));
  }

  /**
   * Picks a private key with the OS file dialog.
   *
   * Opens in `~/.ssh` because that is where the key is, and because on macOS a
   * dot-directory is invisible in the panel until the user knows about
   * Cmd+Shift+period. No extension filter: private keys are as often named
   * `id_ed25519` with no extension as `.pem`, and a filter that hides the
   * common case is worse than none.
   */
  async function pickKeyFile() {
    try {
      const home = await homeDir();
      const picked = await openFile({
        multiple: false,
        directory: false,
        title: "Select an SSH private key",
        defaultPath: `${home.replace(/\/+$/, "")}/.ssh`,
      });
      if (typeof picked === "string") patchSsh({ keyPath: tildePath(picked, home) });
    } catch (e) {
      setError(asDbError(e).message);
    }
  }

  function applyConnString(raw: string) {
    setConnString(raw);
    // Only complain once the string looks like an attempt at a URL, otherwise
    // every keystroke of "postgres" is an error.
    if (!raw.includes("://")) return;
    const parsed = parseConnectionString(raw);
    if (!parsed) {
      setError("Expected a postgres:// or postgresql:// URL.");
      return;
    }
    patch(parsed.patch);
    if (parsed.password) setPassword(parsed.password);
    setError(null);
  }

  /**
   * Dials the server with what is on screen and hangs up again.
   *
   * Nothing is saved and no session is kept: the probe connects under a throwaway
   * id so it cannot disturb a session already open under the real one. `parentId`
   * still points at the saved connection, which is what lets an edit be tested
   * without retyping a password that is already in the keystore.
   */
  async function test() {
    if (ssh && !ssh.host.trim()) {
      setError("The SSH tunnel needs a host to connect through.");
      return;
    }
    setTesting(true);
    setError(null);
    setTested(null);
    const probe: ConnectionConfig = {
      ...form,
      id: crypto.randomUUID(),
      parentId: form.parentId ?? (editing ? form.id : null),
    };
    try {
      const info = await ipc.connect(probe, password || undefined, sshSecret || undefined);
      setTested(`Reached ${info.currentDatabase} on ${info.serverVersion.split(" ")[0]}.`);
    } catch (e) {
      setError(asDbError(e).message);
    } finally {
      // Whether or not the dial succeeded: a probe that stayed open would be a
      // session the user cannot see and cannot close.
      await ipc.disconnect(probe.id).catch(() => {});
      setTesting(false);
    }
  }

  async function submit() {
    // A blank jump host would be dialled as the empty string and come back as
    // a DNS failure, which describes the symptom and not the omission.
    if (ssh && !ssh.host.trim()) {
      setError("The SSH tunnel needs a host to connect through.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const config = { ...form, name: form.name.trim() || `${form.user}@${form.host}` };
      // Save first so the secrets land in the keystore, then connect by id, so
      // neither one has to travel a second time.
      //
      // A blank secret on an existing connection means "leave it alone" —
      // except when the stored one is unreadable or was refused, where leaving
      // it alone would fail exactly the same way again. There, blank clears it.
      const keepStored = editing && !password && !sheet.credentialLost;
      const keepSshStored = editing && !sshSecret && !sheet.sshSecretLost;
      await saveConnection(
        config,
        keepStored ? undefined : password,
        // With no tunnel there is no secret to write, and clearing the stored
        // one would throw away a passphrase the user may switch back on.
        !config.ssh || keepSshStored ? undefined : sshSecret,
      );
      await connect(config);
      setSheet(false);
    } catch (e) {
      setError(asDbError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={sheet.open} onOpenChange={(o) => setSheet(o)}>
      <Dialog.Portal>
        {/* Darker than it was, because the sheet is now darker than the app:
            the scrim has to fall below the sheet for the sheet to read as the
            nearer surface. */}
        <Dialog.Overlay className="overlay-anim fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          onSubmit={(e) => e.preventDefault()}
          className={[
            "sheet-anim fixed top-1/2 left-1/2 z-50 flex max-h-[86vh] w-[min(468px,94vw)]",
            "-translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-sheet",
            "shadow-2xl shadow-black/60 transition-colors duration-200 ease-[var(--ease-out-quart)]",
            env ? env.edge : "border-line",
          ].join(" ")}
        >
          {/* Inset to the header's own left edge rather than run corner to
              corner: a 2px bar bent around a 12px radius reads as a mistake. */}
          {env && (
            <span
              aria-hidden="true"
              className={[
                "absolute inset-x-5 top-0 h-0.5 rounded-b-full",
                "transition-colors duration-200 ease-[var(--ease-out-quart)]",
                env.dot,
              ].join(" ")}
            />
          )}

          <div className="flex shrink-0 items-baseline gap-2 px-5 pt-4 pb-3">
            <Dialog.Title className="text-[13px] font-semibold text-ink">
              {editing ? "Edit connection" : "New connection"}
            </Dialog.Title>
            <span className="text-[11px] text-ink-faint">{spec.label}</span>
          </div>

          <form
            // Capped and scrollable because the tunnel adds a second half to
            // this form: without it a connection through a jump host runs off
            // the bottom of a laptop screen with no way to reach Connect.
            className="min-h-0 flex-1 overflow-y-auto px-5 pb-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {/* One grid for the whole form. Two columns, every row measured
                against the same two edges. */}
            <div className="grid grid-cols-[68px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
              <Row label="URL" id="c-url">
                <input
                  id="c-url"
                  value={connString}
                  onChange={(e) => applyConnString(e.target.value)}
                  placeholder={
                    spec.keyspace
                      ? "redis://user:pass@host:6379/0"
                      : "postgresql://user:pass@host:5432/db"
                  }
                  spellCheck={false}
                  className={`${INPUT_CLS} font-mono text-[11px]`}
                />
              </Row>

              {/* First, because it decides what every field under it means.
                  Disabled while editing: a saved connection's driver is what its
                  stored session, its derived databases, and its open tabs were
                  all built against, and switching it in place would leave those
                  pointing at a server that speaks a different protocol. */}
              <Row
                label="Driver"
                labelId="c-driver"
                hint={editing ? "A saved connection keeps the driver it was made with" : undefined}
              >
                <Segmented labelledBy="c-driver" options={DRIVERS}>
                  {(option) => {
                    const driver = option as (typeof DRIVERS)[number];
                    const on = form.driver === driver.id;
                    return (
                      <button
                        key={driver.id}
                        type="button"
                        aria-pressed={on}
                        disabled={editing}
                        onClick={() => setForm((f) => forDriver(f, driver.id))}
                        className={[
                          "flex h-6 min-w-0 flex-1 items-center justify-center rounded text-[11px]",
                          "disabled:cursor-default",
                          on
                            ? "bg-field text-ink"
                            : "text-ink-muted hover:text-ink disabled:hover:text-ink-muted",
                          // Greyed rather than hidden when editing: the field
                          // still answers "what is this connection", which is
                          // worth reading even when it cannot be changed.
                          editing && !on ? "opacity-40" : "",
                        ].join(" ")}
                      >
                        {driver.label}
                      </button>
                    );
                  }}
                </Segmented>
              </Row>

              <Row label="Name" id="c-name">
                <input
                  id="c-name"
                  // Unless the sheet was reopened to ask for a secret, in
                  // which case that field is the reason the user is here.
                  autoFocus={!sheet.credentialLost && !sheet.sshSecretLost}
                  value={form.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder={`${form.user}@${form.host}`}
                  className={INPUT_CLS}
                />
              </Row>

              {/* One track, four segments: an environment is one choice out of
                  four, and four separate buttons made it look like four. */}
              <Row label="Env" labelId="c-env">
                {/* The chosen segment takes the environment's own colour rather
                    than a neutral raise. One choice out of four is worth a tint;
                    four tints at once would be a legend, not a control. */}
                <Segmented labelledBy="c-env" options={ENVIRONMENTS}>
                  {(option) => {
                    const env = option as (typeof ENVIRONMENTS)[number];
                    const on = form.environment === env.id;
                    return (
                      <button
                        key={env.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => patch({ environment: on ? null : env.id })}
                        className={[
                          "flex h-6 min-w-0 flex-1 items-center justify-center gap-1.5 rounded text-[11px]",
                          on ? env.badge : "text-ink-muted hover:text-ink",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "size-1.5 shrink-0 rounded-full",
                            on ? env.dot : "bg-ink-faint/40",
                          ].join(" ")}
                        />
                        <span className="truncate">{env.label}</span>
                      </button>
                    );
                  }}
                </Segmented>
              </Row>

              <GroupRule label="Server" />

              {/* Host and port are one address, so they are one row.

                  The split is a grid and not a flex row because the port would
                  have had to override the `w-full` that every input carries,
                  and two width utilities are emitted in Tailwind's order rather
                  than the order they are written — `w-full` won, the port field
                  took the whole row, and the host collapsed beside it. A track
                  width is set on the container instead, where nothing competes. */}
              <Row label="Host" id="c-host">
                <div className="grid grid-cols-[minmax(0,1fr)_64px] gap-2">
                  <input
                    id="c-host"
                    value={form.host}
                    onChange={(e) => patch({ host: e.target.value })}
                    className={INPUT_CLS}
                  />
                  <input
                    type="number"
                    aria-label="Port"
                    value={form.port}
                    onChange={(e) => patch({ port: Number(e.target.value) || spec.port })}
                    className={`${INPUT_CLS} text-center font-mono text-[11px]`}
                  />
                </div>
              </Row>

              <Row
                label="User"
                id="c-user"
                hint={
                  spec.keyspace
                    ? "Blank authenticates as the default account"
                    : undefined
                }
              >
                <input
                  id="c-user"
                  value={form.user}
                  onChange={(e) => patch({ user: e.target.value })}
                  placeholder={spec.keyspace ? "default" : undefined}
                  className={INPUT_CLS}
                />
              </Row>

              <Row
                label="Password"
                id="c-password"
                hint={
                  sheet.credentialLost
                    ? "The saved one could not be read back"
                    : editing
                      ? "Blank keeps the saved one"
                      : // Development builds keep credentials in a file rather
                        // than the keystore, so claiming the keystore here would
                        // be a security property the build does not have.
                        import.meta.env.DEV
                        ? "Kept in a local file (development build)"
                        : "Kept in the OS keystore"
                }
              >
                <input
                  id="c-password"
                  type="password"
                  autoFocus={sheet.credentialLost}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={INPUT_CLS}
                />
              </Row>

              <Row label={spec.database.label} id="c-database" hint={spec.database.hint}>
                <input
                  id="c-database"
                  value={form.database}
                  onChange={(e) => patch({ database: e.target.value })}
                  placeholder={spec.database.placeholder}
                  className={INPUT_CLS}
                />
              </Row>

              <Row
                label="SSL"
                labelId="c-ssl"
                hint={
                  ssh && !spec.keyspace
                    ? "Verifying modes need the server's own hostname"
                    : undefined
                }
              >
                <Select
                  labelledBy="c-ssl"
                  value={form.sslMode}
                  // A tunnel rules out the verifying modes for the same reason
                  // on any driver: through it the client dials 127.0.0.1, which
                  // is never the name on the certificate.
                  options={spec.sslModes
                    .filter((m) => !ssh || !m.startsWith("verify"))
                    .map((m) => ({ value: m, label: m }))}
                  onChange={(v) => patch({ sslMode: v as SslMode })}
                />
              </Row>

              {/* The switch lives on the rule that starts its own group: one
                  line doing the work of a heading and a toggle. */}
              <GroupRule label="SSH tunnel" id="c-ssh">
                <span className="max-w-64 truncate text-[10px] text-ink-muted">
                  {ssh
                    ? `via ${ssh.host.trim() || "the jump host"}`
                    : "Reach a database another machine can see"}
                </span>
                <Switch checked={!!ssh} onChange={toggleSsh} labelledBy="c-ssh" />
              </GroupRule>

              {ssh && (
                <div className="reveal-anim col-span-2 grid grid-cols-[68px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
                  <Row label="Host" id="c-ssh-host">
                    <div className="grid grid-cols-[minmax(0,1fr)_64px] gap-2">
                      <input
                        id="c-ssh-host"
                        value={ssh.host}
                        onChange={(e) => patchSsh({ host: e.target.value })}
                        placeholder="bastion.example.com"
                        spellCheck={false}
                        className={INPUT_CLS}
                      />
                      <input
                        type="number"
                        aria-label="SSH port"
                        value={ssh.port}
                        onChange={(e) => patchSsh({ port: Number(e.target.value) || 22 })}
                        className={`${INPUT_CLS} text-center font-mono text-[11px]`}
                      />
                    </div>
                  </Row>

                  <Row label="User" id="c-ssh-user">
                    <input
                      id="c-ssh-user"
                      value={ssh.user}
                      onChange={(e) => patchSsh({ user: e.target.value })}
                      spellCheck={false}
                      className={INPUT_CLS}
                    />
                  </Row>

                  <Row label="Auth" labelId="c-ssh-auth">
                    <Select
                      labelledBy="c-ssh-auth"
                      value={ssh.auth}
                      options={(Object.keys(SSH_AUTH_LABEL) as SshAuth[]).map((a) => ({
                        value: a,
                        label: SSH_AUTH_LABEL[a],
                      }))}
                      onChange={(v) => patchSsh({ auth: v as SshAuth })}
                    />
                  </Row>

                  {ssh.auth === "key" && (
                    /* Both ways of naming the key are on screen at once rather
                       than behind a mode switch: typing is faster when the path
                       is known, browsing is the only option when it is not, and
                       neither is the wrong default often enough to make the
                       user pick a mode before they can start. */
                    <Row
                      label="Key"
                      labelId="c-ssh-key"
                      hint="Blank tries the usual keys in ~/.ssh"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          aria-labelledby="c-ssh-key"
                          value={ssh.keyPath}
                          onChange={(e) => patchSsh({ keyPath: e.target.value })}
                          placeholder="~/.ssh/id_ed25519"
                          spellCheck={false}
                          className={`${INPUT_CLS} min-w-0 flex-1 font-mono text-[11px]`}
                        />
                        <button
                          type="button"
                          onClick={() => void pickKeyFile()}
                          className="pressable h-7 shrink-0 rounded-md bg-field px-2.5 text-[11px] text-ink-muted hover:bg-field-hover hover:text-ink"
                        >
                          Browse
                        </button>
                      </div>
                    </Row>
                  )}

                  <Row
                    label={ssh.auth === "key" ? "Passphrase" : "Password"}
                    id="c-ssh-secret"
                    hint={
                      sheet.sshSecretLost
                        ? "The stored one was refused"
                        : ssh.auth === "key"
                          ? "Only if the key is encrypted. Asked once, then kept."
                          : "Asked once, then kept."
                    }
                  >
                    <input
                      id="c-ssh-secret"
                      type="password"
                      autoFocus={sheet.sshSecretLost}
                      value={sshSecret}
                      onChange={(e) => setSshSecret(e.target.value)}
                      placeholder={editing && !sheet.sshSecretLost ? "Keeping the saved one" : ""}
                      className={INPUT_CLS}
                    />
                  </Row>
                </div>
              )}
            </div>
          </form>

          {/* Outcome sits in the footer, beside the button that produced it, so
              a failed attempt never pushes the form it belongs to off screen. */}
          <div className="flex shrink-0 items-center gap-3 border-t border-line-soft px-5 py-3">
            {editing && (
              <button
                onClick={() => {
                  void deleteConnection(form.id);
                  setSheet(false);
                }}
                className="pressable -ml-2 h-7 rounded-md px-2 text-[12px] text-danger hover:bg-danger/10"
              >
                Delete
              </button>
            )}

            <p
              className={[
                "min-w-0 flex-1 truncate text-[11px]",
                error ? "text-danger" : "text-ink-muted",
              ].join(" ")}
              title={error ?? tested ?? undefined}
            >
              {error ?? tested ?? ""}
            </p>

            <div className="flex shrink-0 items-center gap-1.5">
              <Dialog.Close className="pressable h-7 rounded-md px-2.5 text-[12px] text-ink-muted hover:bg-hover hover:text-ink">
                Cancel
              </Dialog.Close>
              {/* Ahead of Connect, because it answers the same question without
                  saving anything or opening a session. */}
              <button
                type="button"
                disabled={testing || busy}
                onClick={() => void test()}
                className="pressable h-7 rounded-md bg-field px-2.5 text-[12px] text-ink-muted hover:bg-field-hover hover:text-ink disabled:opacity-50"
              >
                {testing ? "Testing…" : "Test"}
              </button>
              <button
                disabled={busy || testing}
                onClick={() => void submit()}
                className="pressable h-7 rounded-md bg-accent px-3 text-[12px] font-medium text-canvas hover:bg-accent/90 disabled:opacity-50"
              >
                {busy ? "Connecting…" : "Connect"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
