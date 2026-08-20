/**
 * The pieces every form in this app is built from.
 *
 * They started inside `ConnectionSheet.tsx` and moved here when the Settings
 * sheet became the second consumer. Two hand-rolled copies of a switch is how
 * the second one ends up a pixel off the first.
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

