import { useLayoutEffect, useRef, useState } from "react";
import { coerce, isContainer, preview, removeAt, setAt, type JsonContainer, type Path } from "@/lib/utils/json";

/**
 * A JSON document, read the way a console prints one.
 *
 * The alternative is what a jsonb cell gives you today: one line of braces in a
 * 320px column. Structure is the thing that makes a document readable, so the
 * structure is what gets drawn — one row per key, containers collapsed until
 * they are asked for.
 *
 * Nothing here animates. Expanding a node is a per-second action while reading,
 * and a transition on it reads as the tree being slow to answer.
 *
 * Editing is opt-in: without `onChange` this is a viewer, which is what the row
 * panel and a query result want. With it, a leaf can be retyped and a key added
 * or removed, and every change is a new document handed back — nothing here
 * touches the database, so the caller decides when one write happens.
 */
export function JsonTree({
  value,
  onChange,
  className,
}: {
  value: JsonContainer;
  onChange?: (next: JsonContainer) => void;
  className?: string;
}) {
  return (
    <div className={["font-mono text-[12px] leading-[1.6]", className ?? ""].join(" ")}>
      <Node
        label={null}
        value={value}
        path={[]}
        depth={0}
        root={value}
        onChange={onChange}
        onRemove={undefined}
      />
    </div>
  );
}

/** Depth at which a container arrives collapsed. Two levels fit on one screen. */
const AUTO_OPEN_DEPTH = 2;

const INDENT = 12;

function Node({
  label,
  value,
  path,
  depth,
  root,
  onChange,
  onRemove,
}: {
  /** The key or index this node sits under, or null at the document root. */
  label: string | null;
  value: unknown;
  path: Path;
  depth: number;
  root: JsonContainer;
  onChange?: (next: JsonContainer) => void;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(depth < AUTO_OPEN_DEPTH);
  const [adding, setAdding] = useState(false);

  const editable = onChange !== undefined;
  const write = (next: unknown) => onChange?.(setAt(root, path, next) as JsonContainer);

  if (!isContainer(value)) {
    return (
      <Row indent={depth} onRemove={onRemove}>
        <Key label={label} />
        <Leaf value={value} editable={editable} onCommit={write} />
      </Row>
    );
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);

  return (
    <>
      <Row indent={depth} onRemove={onRemove}>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="-ml-3 w-3 shrink-0 text-[9px] text-ink-faint hover:text-ink"
        >
          {open ? "▾" : "▸"}
        </button>
        <Key label={label} />
        <span className="truncate text-ink-faint">
          {open ? (Array.isArray(value) ? "[" : "{") : preview(value)}
        </span>
      </Row>

      {open && (
        <>
          {entries.map(([key, child]) => (
            <Node
              key={key}
              label={key}
              value={child}
              path={[...path, Array.isArray(value) ? Number(key) : key]}
              depth={depth + 1}
              root={root}
              onChange={onChange}
              onRemove={
                editable
                  ? () =>
                      onChange?.(
                        removeAt(root, [
                          ...path,
                          Array.isArray(value) ? Number(key) : key,
                        ]) as JsonContainer,
                      )
                  : undefined
              }
            />
          ))}

          {editable &&
            (adding && !Array.isArray(value) ? (
              <Row indent={depth + 1}>
                <KeyInput
                  onCommit={(key) => {
                    setAdding(false);
                    if (key) onChange?.(setAt(root, [...path, key], null) as JsonContainer);
                  }}
                />
              </Row>
            ) : (
              <Row indent={depth + 1}>
                <button
                  onClick={() =>
                    Array.isArray(value)
                      ? onChange?.(
                          setAt(root, [...path, value.length], null) as JsonContainer,
                        )
                      : setAdding(true)
                  }
                  className="rounded px-1 text-[11px] text-ink-faint hover:bg-hover hover:text-ink"
                >
                  + {Array.isArray(value) ? "item" : "key"}
                </button>
              </Row>
            ))}

          <Row indent={depth}>
            <span className="text-ink-faint">{Array.isArray(value) ? "]" : "}"}</span>
          </Row>
        </>
      )}
    </>
  );
}

/** One line of the tree. The remove control is laid out only on hover. */
function Row({
  indent,
  onRemove,
  children,
}: {
  indent: number;
  onRemove?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ paddingLeft: indent * INDENT + INDENT }}
      className="group flex min-w-0 items-baseline gap-1 pr-2 hover:bg-hover"
    >
      {children}
      {onRemove && (
        <button
          onClick={onRemove}
          title="Remove"
          aria-label="Remove"
          className="ml-auto shrink-0 rounded px-1 text-[11px] text-ink-faint opacity-0 group-hover:opacity-100 hover:text-danger"
        >
          −
        </button>
      )}
    </div>
  );
}

function Key({ label }: { label: string | null }) {
  if (label === null) return null;
  return (
    <span className="shrink-0 text-ink-muted">
      {label}
      <span className="text-ink-faint">:</span>
    </span>
  );
}

/**
 * A scalar, coloured the way the same value is coloured in a grid cell, so a
 * number in a document and a number in a column are the same thing on screen.
 */
function Leaf({
  value,
  editable,
  onCommit,
}: {
  value: unknown;
  editable: boolean;
  onCommit: (next: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <ValueInput
        initial={value === undefined ? "null" : JSON.stringify(value)}
        onCommit={(text) => {
          setEditing(false);
          onCommit(coerce(text));
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const tone =
    value === null
      ? "text-null italic"
      : typeof value === "number"
        ? "text-num"
        : typeof value === "boolean"
          ? "text-bool"
          : "text-str";

  const text = value === null ? "null" : JSON.stringify(value);

  if (!editable) return <span className={`min-w-0 truncate ${tone}`}>{text}</span>;

  return (
    <button
      onClick={() => setEditing(true)}
      title="Click to edit"
      className={`min-w-0 truncate rounded px-1 text-left hover:bg-field ${tone}`}
    >
      {text}
    </button>
  );
}

/** Shared field metrics, so a leaf being edited sits on the same baseline. */
const FIELD =
  "min-w-0 flex-1 rounded border border-accent bg-base px-1 font-mono text-[12px] text-ink outline-none";

function ValueInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      data-hotkeys-off=""
      defaultValue={initial}
      spellCheck={false}
      autoComplete="off"
      title='true, 12 and null keep their JSON type. Quote a value to keep it a string: "true"'
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      // A click elsewhere in the tree means "I am done with this leaf", not
      // "throw away what I typed".
      onBlur={(e) => onCommit(e.currentTarget.value)}
      className={FIELD}
    />
  );
}

function KeyInput({ onCommit }: { onCommit: (key: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => ref.current?.focus(), []);

  return (
    <input
      ref={ref}
      data-hotkeys-off=""
      placeholder="key"
      spellCheck={false}
      autoComplete="off"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(e.currentTarget.value.trim());
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCommit("");
        }
      }}
      onBlur={(e) => onCommit(e.currentTarget.value.trim())}
      className={`${FIELD} placeholder:text-ink-faint`}
    />
  );
}
