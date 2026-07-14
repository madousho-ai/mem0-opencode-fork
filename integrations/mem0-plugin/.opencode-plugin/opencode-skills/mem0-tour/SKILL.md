---
name: mem0-tour
description: Browses all stored memories grouped by category with full content display. Use when reviewing all project memories, exploring stored knowledge, onboarding to a project, or getting an overview of captured decisions, conventions, and learnings.
---

# Mem0 Project Tour

Show the user what mem0 has stored for the current project.

The self-hosted server has NO `app_id` field — the plugin folds the repo name
into `user_id`, so "the current project" = "the current user_id". Cross-project
means "override MEM0_USER_ID with the bare identifier the user chose for
sharing across projects".

## Cross-project mode

When invoked with `--all-projects` (e.g., `/mem0-tour --all-projects` or
`/mem0-tour --all-projects auth middleware`), search across every user_id
on the server. This requires admin permissions on the server:

1. Call `get_memories` with `scope="global"` (drops user_id from the filter),
   `page_size=200`.
2. If a search query was also provided, run `search_memories` with
   `query=<query>`, `scope="global"`, `top_k=20`.
3. Group results by `user_id` first, then by category within each user_id.
4. Display:
   ```
   ## <user_id_1> (<N> memories) ← current
   Architecture Decisions - <memory content>
   ...

   ## <user_id_2> (<N> memories)
   ...

   <N> memories across <M> user_ids
   ```
5. Mark the current user_id with `← (current)` in the heading.

If `--all-projects` is NOT present, use the standard single-user_id flow below.

## Peek mode (compact search)

When `/mem0-tour` receives a search query argument (e.g., `/mem0-tour auth middleware`)
WITHOUT `--all-projects`, run in **peek mode** — compact one-liner results.
Filters are flat dicts; the self-hosted server does NOT understand AND/OR trees:

1. Run 2 parallel `search_memories` calls:
   - Broad: `query=<query>`, `filters={"user_id": "<id>"}`, `top_k=10`
   - Targeted: `query=<query>`, `filters={"user_id": "<id>", "type": "decision"}`, `top_k=5`
2. Deduplicate by ID, display compact results:
   ```
   ## mem0 search: "<query>" (<N> results)

   1. [decision] Auth module uses JWT with RS256 keys (2025-05-15) [mem0:a3f8b2c1]
   2. [anti_pattern] Don't use symmetric HS256 — leaked in env (2025-05-10) [mem0:7e2d9f4a]
   3. [convention] All middleware in src/middleware/ (2025-05-08) [mem0:c4d5e6f7]
   ```
   Format: `<number>. [<type>] <content, 80 chars> (<date>) [mem0:<short_id>]`
3. If no results: `No memories matching "<query>" for user_id <active_user_id>.`

If no query argument and no `--all-projects` flag, use the full tour flow below.

## Execution

### Step 1: Fetch ALL memories for this user_id

Call `get_memories` to fetch memories for the current user_id:

`filters={"user_id": "<active_user_id>"}`, `page_size=100`

(Note: the self-hosted GET /memories endpoint honors identity + `top_k` only —
extra metadata filters go into the response but not the query.)

### Step 2: Run supplementary semantic searches

In parallel, run these `search_memories` calls to get relevance-ranked results for key topics:

- `query="architecture decisions design choices"`, `filters={"user_id": "<id>"}`, `top_k=10`
- `query="bugs errors failures anti-patterns"`, `filters={"user_id": "<id>"}`, `top_k=10`
- `query="project setup tooling conventions preferences"`, `filters={"user_id": "<id>"}`, `top_k=10`

Do NOT filter by `metadata.type` in these calls — filtering there misses
memories tagged only by the writer's ad-hoc convention.

### Step 3: Merge and group

Merge all results by memory ID (deduplicate). For each memory, determine its
group from `metadata.type` (the self-hosted server has no server-side
`categories` field — grouping relies on the type you set at write time). Fall
back to "other" when `metadata.type` is missing.

Map `metadata.type` to display names:

| metadata.type | Display name |
|---|---|
| `architecture_decisions`, `decision` | Architecture Decisions |
| `anti_patterns`, `anti_pattern` | Anti-Patterns |
| `task_learnings`, `task_learning` | Task Learnings |
| `coding_conventions`, `convention` | Coding Conventions |
| `user_preferences`, `user_preference` | User Preferences |
| `project_profile` | Project Profile |
| `tooling_setup`, `environmental` | Tooling & Setup |
| `session_state` | Session State |
| `compact_summary` | Compact Summaries |
| anything else | Other |

### Step 4: Display results

Sort groups by descending memory count. Display in compact tabular format:

First show the category summary table:

```
mem0 tour

Session (ses_abc123)  branch: main
User: alice-a1b2c3d4  -  349 memories

Category                   Count
-----------------------------------------
tooling_setup                119
bug_fixes                     78
architecture_decisions        32
task_learnings                14
...
```

Then for each category (sorted by count descending), show memories as numbered one-liners. Truncate each memory to 100 chars max:

```
tooling_setup (119)
  1. User requires that no git commit or push be performed without explicit permission...
  2. OpenCode plugins are loaded from ~/.config/opencode/plugins/ for global installation...
  3. Assistant determined that the symlink method for loading the Mem0 plugin was failing...
  ... and 116 more

bug_fixes (78)
  1. Fixed getAll filter format from flat object to AND-wrapped array for mem0ai TS SDK v3...
  2. Root cause of user_id mismatch: plugin derived kartik.labhshetwar from git email...
  ... and 76 more
```

Show top 5 memories per category by recency. If a group has more than 5, note `... and <N> more`.

Skip empty groups entirely.

### Step 5: Print totals

```
<N> memories across <M> categories
user_id: <active_user_id>  branch: <active_branch>

Identity - user_id: <user_id>  branch: <branch>
```

### Step 6: Empty state

If zero memories found for this user_id, print:
```
No memories stored yet for user_id <active_user_id>.
Start working - mem0 captures learnings automatically, or use /mem0-remember to save something now.
```

## Output formatting

IMPORTANT: Do NOT use markdown in your output. OpenCode TUI renders text verbatim - markdown like **bold**, ## headers, and | table | syntax appears as raw characters. Use plain text with indentation for structure. Use dashes for lists. Use spaces to align columns instead of markdown tables.
