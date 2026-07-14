---
name: mem0-scope
description: Views or changes the default memory scope (project, session, or global) used when saving and searching memories. Use when the user wants to control whether memories are scoped to this user_id, this run, or every memory the server holds.
---

# Mem0 Scope

View or change the **default memory scope** — the scope the memory tools use when
no explicit `scope` is given. The setting persists in `~/.mem0/settings.json`
(`default_scope`) and the plugin reads it fresh on each memory operation, so a
change takes effect immediately in the current session.

The three scopes (self-hosted server: identity is just `user_id` + optional
`run_id`; the project name is folded into `user_id` at plugin startup):

- `project` (default) — this repo only. Filters by the current `user_id`.
- `session` — this run only. Adds `run_id` (the current session) so memories
  are isolated to this conversation.
- `global` — server-wide. Drops `user_id` from filters so reads and writes
  span every memory this server holds.

## Execution

### Step 1: Determine intent

Look at the user's message for a target scope word: `project`, `session`, or
`global` (also accept "repo"→project, "run"→session, "all"/"everywhere"→global).

- No target word present → **View mode** (Step 2).
- A target word present → **Change mode** (Step 3).

### Step 2: View mode — show the current scope

1. Read the current default scope from settings:

   ```bash
   _S="$HOME/.mem0/settings.json"
   [ -f "$_S" ] && grep -o '"default_scope"[[:space:]]*:[[:space:]]*"[a-z]*"' "$_S" | grep -o '[a-z]*"$' | tr -d '"' || echo "project"
   ```

   If the command prints nothing, the scope is `project` (the default).

2. (Optional) Show how many memories live in the current scope by calling
   `get_memories` with `scope="<current>"`, `page_size=1`, and reading the
   `count` (or result length) from the response.

3. Display using the identity the plugin exported (do NOT re-shell git):

   ```
   Mem0 memory scope

   Current default scope: <current>

     project  - this user_id only                         <marker if active>
     session  - this run only (adds run_id)               <marker if active>
     global   - server-wide (drops user_id from filters)  <marker if active>

   User:    ${MEM0_USER_ID}
   Session: ${MEM0_SESSION_ID}

   To change: /mem0-scope session    (or project / global)
   ```

   Put `[active]` next to the current scope. If you fetched a count in step 2,
   add a `Memories in scope: <N>` line.

### Step 3: Change mode — set a new scope

1. Validate the target is one of `project`, `session`, `global`. If not, show the
   three options and stop.

2. Read the existing settings so you preserve every other key. Use the Read tool
   on `~/.mem0/settings.json` (it may not exist yet — treat a missing file as
   `{}`).

3. Write the file back with the Write tool, keeping ALL existing keys and only
   setting `"default_scope"` to the target. Pretty-print with 2-space indent and
   a trailing newline. Do not drop `global_search`, `dream`, `auto_save`, or any
   other field that was present.

   Example resulting file (when other keys already existed):

   ```json
   {
     "auto_save": true,
     "search_limit": 10,
     "default_scope": "global"
   }
   ```

4. Confirm:

   ```
   Default memory scope changed: <old> -> <new>

   <one line describing the effect — see below>
   Applies immediately to memory tools in this session.

   To revert: /mem0-scope <old>
   ```

   Effect lines:
   - project → "New memories and searches are limited to the current user_id (this repo)."
   - session → "New memories and searches are limited to this run (this conversation)."
   - global  → "New memories and searches drop user_id — they span every memory on this self-hosted server. delete_all_memories still needs an explicit scope=global to delete server-wide."

### Notes

- This only changes the **default**. Any memory tool call can still pass an
  explicit `scope` to override it for that one call.
- `delete_all_memories` deliberately ignores the default scope: deleting
  server-wide always requires an explicit `scope="global"`, so changing the
  default can never turn a routine cleanup into a cross-user wipe. The
  self-hosted server also requires an admin API key for that call.
- `global` scope (drop user_id) is distinct from the separate `global_search`
  setting (drop user_id at session-start context loading). Leave
  `global_search` untouched here.

## Output formatting

IMPORTANT: Do NOT use markdown in your output. OpenCode TUI renders text verbatim — markdown like **bold**, ## headers, and | table | syntax appears as raw characters. Use plain text with indentation for structure. Use dashes for lists. Use spaces to align columns instead of markdown tables.
