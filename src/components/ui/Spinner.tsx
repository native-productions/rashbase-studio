/**
 * The one loading indicator in the application.
 *
 * Drawn at the size of the thing it replaces rather than added beside it: a
 * connection row's status dot becomes this while the connection is being made,
 * and a schema's caret becomes this while the schema is being read. Nothing
 * moves, so the list does not reflow the moment a click lands.
 *
 * Fast on purpose. A spinner that turns quickly makes a wait feel shorter than
 * the same wait under a slow one, and the numbers here are the only claim this
 * component makes.
 *
 * Inherits `currentColor`, so where it goes decides what colour it is.
 */
export function Spinner({
  size = 10,
  className = "",
  label = "Loading",
}: {
  size?: number;
  className?: string;
  /** What is being waited for, for anyone not looking at the screen. */
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role="status"
      aria-label={label}
      className={`spin shrink-0 ${className}`}
    >
      <circle
        cx="8"
        cy="8"
        r="6.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        // Circumference is ~40. Three quarters of it is enough arc to read as
        // turning, and enough gap to read as unfinished.
        strokeDasharray="30 12"
      />
    </svg>
  );
}
