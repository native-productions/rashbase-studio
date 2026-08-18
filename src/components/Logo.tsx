/** Concept D: a 2x2 grid with one cell selected, bottom-right corner notched. */
export function Logo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" />
      <rect
        x="13"
        y="3"
        width="8"
        height="8"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.45"
      />
      <rect
        x="3"
        y="13"
        width="8"
        height="8"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.45"
      />
      <path
        d="M13.8 13h6.4a.8.8 0 0 1 .8.8v2.7L16.5 21h-2.7a.8.8 0 0 1-.8-.8v-6.4a.8.8 0 0 1 .8-.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.45"
        strokeLinejoin="round"
      />
    </svg>
  );
}
