/** How much of an unrecognised version string still fits the status bar. */
const FALLBACK_LENGTH = 24;

/**
 * The part of `version()` worth the space in the status bar.
 *
 * Postgres reports the build platform and compiler too:
 * "PostgreSQL 16.2 (Debian 16.2-1) on aarch64-unknown-linux-gnu, compiled by
 * gcc…". The product and the number are the two things a person checks.
 */
export function shortServerVersion(full: string): string {
  const m = full.match(/^(\w+)\s+([\d.]+)/);
  return m ? `${m[1]} ${m[2]}` : full.slice(0, FALLBACK_LENGTH);
}
