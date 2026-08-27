/**
 * The pieces every form in this app is built from.
 *
 * They started inside `ConnectionSheet.tsx` and moved here when the Settings
 * sheet became the second consumer. Two hand-rolled copies of a switch is how
 * the second one ends up a pixel off the first.
 *
 * `Field`, `Box` and `Check` arrived the same way, out of `ExportDialog.tsx`
 * when the import dialog became its peer. The two vocabularies below are not
 * one: `Row` and `Switch` build a two-column grid that reads across, `Field`
 * and `Check` build a stack of labelled bands that reads down. A dialog picks
 * one and stays in it. Mixing them in the same pane is how a form ends up with
 * two different left edges.
 */

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
export function Row({
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
export function GroupRule({ label, id, children }: { label: string; id?: string; children?: React.ReactNode }) {
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
export function Switch({
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

/** One labelled band of the form. The label is the only thing that repeats. */
export function Field({
  label,
  note,
  children,
}: {
  label: string;
  note?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 flex flex-col gap-2 last:mb-0">
      <h2 className="label-eyebrow">{label}</h2>
      {children}
      {note && <p className="text-[11px] text-ink-faint">{note}</p>}
    </section>
  );
}

/**
 * A checkbox with a third state for "some of what is under this".
 *
 * Drawn rather than native because a native indeterminate box cannot be styled
 * to sit in this palette, and the three states have to be told apart at 13px.
 */
export function Box({
  state,
  label,
  onToggle,
  disabled = false,
}: {
  state: "on" | "off" | "some";
  label: string;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <span
      role="checkbox"
      aria-checked={state === "some" ? "mixed" : state === "on"}
      aria-label={label}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          if (!disabled) onToggle();
        }
      }}
      className={[
        "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
        disabled ? "opacity-40" : "",
        state === "off"
          ? "border-line bg-transparent"
          : "border-accent bg-accent-fill text-on-accent",
      ].join(" ")}
    >
      {state === "on" && (
        <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
          <path
            d="M1.5 4.5l2 2 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {state === "some" && <span className="h-0.5 w-1.5 rounded-full bg-canvas" />}
    </span>
  );
}

export function Check({
  checked,
  label,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={[
        "flex w-fit items-center gap-2 text-[12px]",
        disabled ? "text-ink-faint" : "cursor-default text-ink-muted hover:text-ink",
      ].join(" ")}
    >
      <Box
        state={checked ? "on" : "off"}
        label={label}
        disabled={disabled}
        onToggle={() => onChange(!checked)}
      />
      {label}
    </label>
  );
}
