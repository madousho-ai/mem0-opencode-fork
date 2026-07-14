/**
 * Memory scope resolution for the self-hosted mem0 server.
 *
 * The self-hosted server has no `app_id` field — project isolation is folded
 * into `user_id` at plugin startup (see `getUserId` in opencode-mem0.ts). Scope
 * thus reduces to a choice between the current user_id (project), a run_id
 * narrowing (session), or dropping user_id (global — user-wide across every
 * MEM0_USER_ID this OS user has ever used against the server).
 */

export type Scope = "project" | "session" | "global";

export function scopeSearchFilters(
  scope: Scope,
  userId: string,
  runId: string,
): Record<string, string> {
  switch (scope) {
    case "session":
      return {user_id: userId, run_id: runId};
    case "global":
      return {};
    case "project":
    default:
      return {user_id: userId};
  }
}

export function scopeWriteParams(
  scope: Scope,
  userId: string,
  runId: string,
): {user_id?: string; run_id?: string} {
  switch (scope) {
    case "session":
      return {user_id: userId, run_id: runId};
    case "global":
      return {};
    case "project":
    default:
      return {user_id: userId};
  }
}

export function asScope(value: unknown): Scope {
  return value === "session" || value === "global" ? value : "project";
}

export function resolveDefaultScope(
  settings: Record<string, unknown> | null | undefined,
): Scope {
  return asScope(settings?.default_scope);
}

export const SCOPE_GUIDANCE =
  'Memory tools accept an optional `scope`: omit it (or "project") for normal queries; use "session" to limit to the current run; use "global" ONLY when the user explicitly asks to search their entire user-wide store (self-hosted server: this drops user_id from the filter).';
