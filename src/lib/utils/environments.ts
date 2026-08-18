import { ENVIRONMENTS, type Environment } from "@/lib/constants/environments";

const BY_ID = new Map(ENVIRONMENTS.map((e) => [e.id, e]));

/**
 * Connections saved before the labels became a fixed set still hold free text
 * ("prod", "Staging server"). Match on prefix so those keep their colour
 * instead of falling back to grey.
 */
export function findEnvironment(value: string | null | undefined): Environment | null {
  if (!value) return null;
  const needle = value.trim().toLowerCase();
  if (!needle) return null;
  return BY_ID.get(needle) ?? ENVIRONMENTS.find((e) => e.id.startsWith(needle)) ?? null;
}
