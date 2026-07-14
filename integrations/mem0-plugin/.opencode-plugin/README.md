# @mem0/opencode-plugin (self-hosted)

Persistent memory for [OpenCode](https://opencode.ai), backed by a **self-hosted
mem0 FastAPI server** (this repo's `server/`). Not the mem0.ai cloud platform.

Your agent remembers decisions, preferences, and learnings across sessions
automatically.

## Install

```bash
opencode plugin @mem0/opencode-plugin
```

This adds the plugin to your `~/.config/opencode/opencode.json`. The plugin
registers its memory tools and skills itself — there is no MCP server to
configure.

## Point the plugin at your server

```bash
# REQUIRED: base URL of your self-hosted mem0 server.
echo 'export MEM0_API_BASE_URL="http://localhost:8888"' >> ~/.zshrc

# OPTIONAL: only needed when your server was started without AUTH_DISABLED=true.
# X-API-Key header (server-issued via POST /api-keys or ADMIN_API_KEY).
echo 'export MEM0_API_KEY="m0sk_your-key"' >> ~/.zshrc

source ~/.zshrc
```

Restart OpenCode.

If `MEM0_API_BASE_URL` is not set, the plugin logs an error and no memory tools
are registered.

## What changed vs the cloud plugin

This is a **breaking fork** of the upstream `@mem0/opencode-plugin`. Not
API-compatible with the cloud plugin:

| | Cloud plugin | This fork |
|---|---|---|
| Backend | `api.mem0.ai/v1/*` (hosted) | Any `MEM0_API_BASE_URL` (this repo's `server/`) |
| Auth header | `Authorization: Token m0-...` | `X-API-Key: m0sk_...` (optional) |
| SDK | `mem0ai` npm package | Bundled thin HTTP client (`client.ts`), no npm dep |
| `app_id` | Top-level field | Removed — folded into `user_id` (see below) |
| Custom categories | Cloud LLM post-processing | Not available; `metadata.type` only |
| Async event queue (`event_id`) | Yes | Server responds synchronously |
| Complex `AND/OR` filters | Yes | Flat metadata equality only |
| `get_event_status` tool | Yes | Removed |

## Identity & scope

- `user_id` — **defaults to `<os_user>-<git_project>`** (auto-detected from the
  git remote or repo root name). This is how per-repo isolation is achieved on
  a server that has no `app_id` field.
- Set `MEM0_USER_ID` to override — e.g. `MEM0_USER_ID=alice` to share memory
  across every repo you touch.
- `run_id` — a fresh `ses_<epoch>_<hex>` per OpenCode session (for `session`
  scope).

Every memory tool accepts an optional `scope`. Set the default with
`/mem0-scope`:

| Scope | Reads | Writes |
|-------|-------|--------|
| `project` (default) | `user_id` filter (= this repo by default) | current `user_id` |
| `session` | `user_id` + `run_id` | `user_id` + `run_id` |
| `global` | no `user_id` filter (server-wide) | no `user_id` (server may require admin) |

```
/mem0-scope            # show the current default scope
/mem0-scope global     # search / write server-wide by default
/mem0-scope project    # back to repo-only (default)
```

The default persists in `~/.mem0/settings.json` (`default_scope`) and is read
fresh on each memory operation, so a change applies immediately — no restart.
`delete_all_memories` always requires an explicit `scope="global"` to delete
server-wide, so changing the default can't trigger a cross-user wipe. The
self-hosted server also requires an admin API key for that call.

## What's included

| Component | Description |
|-----------|-------------|
| **9 Native Memory Tools** | `add_memory`, `search_memories`, `get_memories`, `get_memory`, `update_memory`, `delete_memory`, `delete_all_memories`, `delete_entities`, `list_entities` — registered as OpenCode tools, backed by the bundled `Mem0HttpClient` (no MCP server, no npm SDK) |
| **Lifecycle Hooks** | Auto-search on session start and every prompt, error memory lookup, compaction context, secret redaction |
| **9 Skills** | `/mem0-remember`, `/mem0-tour`, `/mem0-search`, `/mem0-status`, `/mem0-scope`, `/mem0-dream`, `/mem0-forget`, `/mem0-pin`, `/mem0-context-loader` — discovered in place from the plugin via OpenCode's `skills.paths` |

## Hooks

| Hook | Event | What it does |
|------|-------|-------------|
| **Config** | `config` | Registers the `/mem0-*` slash commands (via `config.command`) and adds the plugin's own `opencode-skills/` dir to OpenCode's `skills.paths` for in-place skill discovery |
| **Chat message** | `chat.message` | Loads prior memories on session start, searches relevant memories before each prompt, auto-captures learnings periodically |
| **Pre-tool** | `tool.execute.before` | Blocks MEMORY.md writes, steering them to the `add_memory` tool |
| **Post-tool** | `tool.execute.after` | Scans bash errors and pre-fetches related memories |
| **Messages transform** | `experimental.chat.messages.transform` | Injects memory context (session memories, search results, error lookups) into the prompt |
| **Compaction** | `experimental.session.compacting` | Stores session state memory, then injects prior memories into compaction context so nothing is lost |
| **Shell env** | `shell.env` | Exports `MEM0_USER_ID`, `MEM0_SESSION_ID`, `MEM0_BRANCH`, `MEM0_GLOBAL_SEARCH` to shell |

## Memory Tools

| Tool | Description |
|------|-------------|
| `add_memory` | Save text or conversation history |
| `search_memories` | Semantic search across memories |
| `get_memories` | List memories in a scope (`page_size` maps to server `top_k`; server has no true pagination) |
| `get_memory` | Retrieve a specific memory by ID |
| `update_memory` | Overwrite a memory's text by ID |
| `delete_memory` | Delete a single memory by ID |
| `delete_all_memories` | Bulk delete in a scope (server requires admin) |
| `delete_entities` | Delete a `user_id`/`agent_id`/`run_id` and every memory attached (server requires admin) |
| `list_entities` | List entities; `page`/`page_size` slice the result client-side |

## Verify

Start OpenCode and ask: *"Search my memories for recent decisions"*

If the `mem0` tools respond, you're all set. Or run `/mem0-status` for a
full diagnostic (endpoint, identity, connectivity, write/read).

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No tools appearing | Restart OpenCode after installing |
| Plugin logs "MEM0_API_BASE_URL environment variable not set" | Export it, restart OpenCode |
| 401 / 403 | Check `MEM0_API_KEY` matches a key on the server, or start server with `AUTH_DISABLED=true` |
| 404 on `/memories` | Check `MEM0_API_BASE_URL` — must be root, no `/v1/` suffix |
| `delete_all_memories` refused | Server requires admin; use `ADMIN_API_KEY` on server side |

## License

Apache-2.0
