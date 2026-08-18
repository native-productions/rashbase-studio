import { useId } from "react";

/**
 * A short row of mutually exclusive choices, all of them visible.
 *
 * Used where a dropdown would hide half the answer behind a click: with two or
 * three options the whole decision fits on one line, and seeing the alternative
 * is most of what makes the choice easy.
 *
 * The selected pill is one element that slides, rather than a background that
 * appears on the new option and vanishes from the old. That is the only motion
 * here, and it is `transform` alone.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  /** Names the group for a screen reader; there is no visible legend. */
  label: string;
  disabled?: boolean;
}) {
  const name = useId();
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={[
        "relative flex h-7 rounded-md bg-field p-0.5",
        disabled ? "opacity-40" : "",
      ].join(" ")}
    >
      <div
        aria-hidden="true"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
        className="absolute top-0.5 bottom-0.5 left-0.5 rounded bg-field-hover transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
      />
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            name={name}
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={[
              "relative z-10 flex-1 rounded text-[12px] disabled:pointer-events-none",
              on ? "text-ink" : "text-ink-muted hover:text-ink",
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
