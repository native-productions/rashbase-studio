/**
 * Environment labels are a fixed set, not free text.
 *
 * The point of the label is recognition at a glance — a colour you have seen
 * a hundred times reads faster than a word you have to parse. Free text made
 * "prod", "PROD" and "production" three different things, which defeats that.
 *
 * Red belongs to production alone. Nothing else in the app is allowed to use
 * it, so red always means "this is the one you cannot undo".
 */
export interface Environment {
  id: string;
  label: string;
  /** Filled dot on the card and in the connection list. */
  dot: string;
  /** Badge treatment: tinted background plus matching text. */
  badge: string;
  /** Edge of a surface that belongs to this environment, at the strength a
   *  border can carry without becoming the loudest thing on the sheet. */
  edge: string;
}

export const ENVIRONMENTS: Environment[] = [
  {
    id: "local",
    label: "Local",
    dot: "bg-str",
    badge: "bg-str/15 text-str",
    edge: "border-str/55",
  },
  {
    id: "development",
    label: "Development",
    dot: "bg-num",
    badge: "bg-num/15 text-num",
    edge: "border-num/55",
  },
  {
    id: "staging",
    label: "Staging",
    dot: "bg-warn",
    badge: "bg-warn/15 text-warn",
    edge: "border-warn/55",
  },
  {
    id: "production",
    label: "Production",
    dot: "bg-danger",
    badge: "bg-danger/15 text-danger",
    edge: "border-danger/55",
  },
];
