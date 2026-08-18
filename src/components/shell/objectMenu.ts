import type { ContextMenuItem } from "@/components/ui/ContextMenu";
import type { PendingAction } from "@/components/table/DestructiveDialog";
import { ipc } from "@/lib/ipc";
import {
  insertStatement,
  quoteIdent,
  selectStatement,
  updateStatement,
} from "@/lib/utils/sql";
import type { DbObject, StatementColumn } from "@/lib/types";

/**
 * What the right-click menu offers, decided by what the object actually is.
 *
 * A view cannot be truncated and a function has no columns to write a
 * statement against, so those entries are absent rather than present and
 * failing when pressed.
 *
 * Only an ordinary table is offered the destructive pair. A catalogue relation
 * listed under Cluster is `other`, and offering to truncate `pg_roles` is not a
 * mistake worth leaving one misclick away.
 *
 * `selectedCount` is how many rows the gesture would act on, so the entry can
 * say what it will actually do. "Export…" on a four-row selection would be a
 * menu that does not describe itself.
 */
export function objectMenuItems(object: DbObject, selectedCount = 1): ContextMenuItem[] {
  const isFunction = object.kind === "function";
  const isTable = object.kind === "table";

  const items: ContextMenuItem[] = [
    {
      kind: "submenu",
      label: "Copy",
      items: [
        { id: "copy.name", label: "Name" },
        ...(isFunction
          ? []
          : [
              { id: "copy.select", label: "As select statement" },
              { id: "copy.insert", label: "As insert statement" },
              { id: "copy.update", label: "As update statement" },
            ]),
      ],
    },
  ];

  // A function has nothing to dump; everything else in the tree does.
  if (!isFunction) {
    items.push(
      { kind: "separator" },
      {
        kind: "item",
        id: "export",
        label: selectedCount > 1 ? `Export ${selectedCount} tables…` : "Export…",
        hint: "⌘⇧E",
      },
    );
  }

  if (isTable) {
    items.push(
      { kind: "separator" },
      { kind: "item", id: "truncate", label: "Truncate…", danger: true },
      { kind: "item", id: "drop", label: "Drop table…", danger: true },
    );
  } else if (object.kind === "view" || object.kind === "matview") {
    items.push(
      { kind: "separator" },
      {
        kind: "item",
        id: "drop",
        label: object.kind === "matview" ? "Drop materialized view…" : "Drop view…",
        danger: true,
      },
    );
  }

  return items;
}

/**
 * Performs a menu choice.
 *
 * Copying happens here. Destroying does not: those two return a description of
 * what was asked for, and the caller puts it in front of the user before
 * anything runs.
 */
export async function runObjectMenuAction(
  id: string,
  connectionId: string,
  object: DbObject,
): Promise<{ pending?: PendingAction; copied?: string }> {
  if (id === "truncate" || id === "drop") {
    return {
      pending: {
        action: id,
        schema: object.schema,
        name: object.name,
        kind: object.kind,
      },
    };
  }

  if (id === "copy.name") {
    // Qualified, because an unqualified name pasted into a query only works
    // when the search path happens to agree.
    const text = `${quoteIdent(object.schema)}.${quoteIdent(object.name)}`;
    await navigator.clipboard.writeText(text);
    return { copied: "Table name copied." };
  }

  // The remaining actions need the column list. Fetched on use rather than on
  // every right-click, which would be a catalogue query per menu open.
  const columns: StatementColumn[] = (
    await ipc.listColumns(connectionId, object.schema, object.name)
  ).map((c) => ({ name: c.name, primaryKey: c.primaryKey }));

  const build: Record<string, () => string> = {
    "copy.select": () => selectStatement(object.schema, object.name, columns),
    "copy.insert": () => insertStatement(object.schema, object.name, columns),
    "copy.update": () => updateStatement(object.schema, object.name, columns),
  };
  const make = build[id];
  if (!make) return {};

  await navigator.clipboard.writeText(make());
  const what = id.slice(5);
  return { copied: `${what[0]?.toUpperCase()}${what.slice(1)} statement copied.` };
}
