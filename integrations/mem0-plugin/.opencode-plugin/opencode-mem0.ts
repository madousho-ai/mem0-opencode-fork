// Mem0 memory plugin for OpenCode: captures and recalls memories across sessions
// (add / search / manage) against a SELF-HOSTED mem0 FastAPI server
// (mem0-opencode-fork/server/), wired through OpenCode plugin hooks. Memory
// operations are exposed as native OpenCode tools backed by our own thin HTTP
// client (client.ts), NOT the cloud `mem0ai` SDK — the cloud SDK targets the
// hosted platform and its extras (customCategories, event queue, AND/OR
// filters, top-level app_id) that the self-hosted server does not implement.
//
// Multi-project safety: OpenChamber (and any host that runs multiple OpenCode
// projects inside ONE server process) will fire every hook with a `sessionID`
// tied to a specific project. We resolve `user_id` per-session by looking up
// the session's `projectID` on demand and caching it, so memories written from
// project A never leak into project B's bucket.
import type {Plugin, PluginInput} from "@opencode-ai/plugin";
import {tool} from "@opencode-ai/plugin";
import {Mem0HttpClient} from "./client";
import {userInfo} from "os";
import {basename, resolve, dirname} from "path";
import {existsSync, readFileSync, readdirSync} from "fs";
import {homedir} from "os";
import {join} from "path";
import {
  loadDreamConfig,
  incrementSessionCount,
  checkCheapGates,
  checkMemoryGate,
  acquireDreamLock,
  releaseDreamLock,
  recordDreamCompletion,
  DREAM_PROTOCOL,
} from "./dream";
import {asScope, scopeSearchFilters, scopeWriteParams, resolveDefaultScope, SCOPE_GUIDANCE, type Scope} from "./scope";

function getOsUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || "unknown";
  }
}

// OpenCode's Project has no explicit `name` field, so we derive a
// human-readable identifier from the worktree path's last segment AND append
// the first 8 chars of `project.id` so two projects with the same folder name
// (`/home/a/foo` vs `/tmp/foo`) still get distinct user_ids. If only one of
// worktree/id is available we degrade gracefully. Set MEM0_USER_ID explicitly
// to override the whole scheme.
const ID_SUFFIX_LEN = 8;

function projectSlug(worktree?: string, id?: string): string | undefined {
  const name = worktree ? basename(worktree.replace(/\/+$/, "")) : "";
  const suffix = id ? id.slice(0, ID_SUFFIX_LEN) : "";
  if (name && suffix) return `${name}-${suffix}`;
  return name || suffix || undefined;
}

function projectUserId(project: PluginInput["project"] | undefined): string {
  if (process.env.MEM0_USER_ID) return process.env.MEM0_USER_ID;
  const osUser = getOsUser();
  const slug = projectSlug(project?.worktree, project?.id);
  return slug ? `${osUser}-${slug}` : osUser;
}

async function getBranch($: any): Promise<string> {
  try {
    const r = await $`git branch --show-current`.quiet();
    return r.stdout.toString().trim() || "main";
  } catch {
  }
  return "main";
}

function extractMemories(res: any): Array<{ memory: string; id: string }> {
  const arr = res?.results ?? res;
  if (!Array.isArray(arr)) return [];
  return arr.map((m: any) => ({memory: m.memory ?? "", id: m.id ?? ""}));
}

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/g,
  /m0-[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  /ghp_[A-Za-z0-9]{36,}/g,
  /gho_[A-Za-z0-9]{36,}/g,
];

function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

function loadSettings(): Record<string, unknown> {
  try {
    const settingsPath = join(homedir(), ".mem0", "settings.json");
    if (!existsSync(settingsPath)) return {};
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
  }
  return {};
}

function loadGlobalSearch(): boolean {
  return loadSettings().global_search === true;
}

function loadDefaultScope(): Scope {
  return resolveDefaultScope(loadSettings());
}

const NUDGE_RE =
  /\b(remember\s+(this|that)|memorize|save\s+this|note\s+(this|that)|don'?t\s+forget|always\s+remember|never\s+forget|keep\s+(this|that)\s+in\s+(mind|memory)|store\s+(this|that))\b/i;

const RESUME_RE =
  /where\s+(did\s+)?(we|I)\s+(leave|left)\s+off|continue\s+(from\s+)?(where|last)|what\s+were\s+we\s+(working|doing)|pick\s+up\s+where|resume\s+(from\s+|where\s+)|what.s\s+the\s+(current|latest)\s+(state|status)|catch\s+me\s+up|where\s+are\s+we/i;

const ERROR_STRONG_RE =
  /Traceback \(most recent call last\)|panic: |FATAL:|error\[E\d+\]/;
const ERROR_MULTI_RE = /(Error:|Exception:)/g;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "write", "edit", "multiEdit"]);

function resolveFilters(args: any, globalSearch: boolean, userId: string): Record<string, unknown> {
  // Self-hosted server passes `filters` straight through to mem0 OSS which only
  // understands flat metadata equality — no AND/OR trees, no user_id="*".
  const base: Record<string, unknown> = {};
  if (args.agent_id) {
    base.agent_id = args.agent_id;
  } else if (!globalSearch) {
    base.user_id = args.user_id ?? userId;
  }
  if (args.filters && typeof args.filters === "object") {
    return {...base, ...(args.filters as Record<string, unknown>)};
  }
  return base;
}

function extractUserText(input: any, output: any): string {
  const parts: any[] = output?.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((p: any) => p.type === "text" && !p.synthetic)
      .map((p: any) => p.text ?? "")
      .join("\n");
  }
  const msg = output?.message ?? input?.message;
  if (typeof msg?.content === "string") return msg.content;
  if (typeof msg?.text === "string") return msg.text;
  return "";
}

interface SessionState {
  userId: string;
  runId: string;
  initialized: boolean;
  memoryCount: number;
  msgCount: number;
  systemContext: string[];
  stats: {adds: number; searches: number; messages: number};
  dreamTriggered: boolean;
  dreamWriteSeen: boolean;
}

const SESSION_CACHE_MAX = 100;

const Mem0Plugin: Plugin = async (ctx) => {
  const {$, client, project} = ctx;

  const baseUrl = process.env.MEM0_API_BASE_URL;
  if (!baseUrl) {
    try {
      await client.app.log({
        body: {
          service: "mem0",
          level: "error",
          message:
            "MEM0_API_BASE_URL environment variable not set. Point it at your self-hosted mem0 server (e.g. http://localhost:8888).",
        },
      });
    } catch {
    }
    return {};
  }

  const apiKey = process.env.MEM0_API_KEY;
  const mem0 = new Mem0HttpClient(baseUrl, apiKey);
  const branch = await getBranch($);
  const globalSearch = loadGlobalSearch();

  const mem0StateDir = join(homedir(), ".mem0");
  const dreamConfig = loadDreamConfig(mem0StateDir);

  const sessions = new Map<string, SessionState>();

  // Resolve user_id for a specific OpenCode sessionID by fetching the session's
  // projectID from the OpenCode server. Result is cached in the session-state
  // map, so the lookup runs at most once per session ID.
  async function resolveUserIdForSession(sessionID: string): Promise<string> {
    if (process.env.MEM0_USER_ID) return process.env.MEM0_USER_ID;
    try {
      const res: any = await client.session.get({path: {id: sessionID}});
      const info: any = res?.data ?? res;
      const directory: string | undefined = info?.directory;
      const projectID: string | undefined = info?.projectID;
      const slug = projectSlug(directory, projectID);
      if (slug) return `${getOsUser()}-${slug}`;
    } catch {
    }
    return projectUserId(project);
  }

  async function getSessionState(sessionID: string): Promise<SessionState> {
    let state = sessions.get(sessionID);
    if (state) return state;
    if (sessions.size >= SESSION_CACHE_MAX) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    const userId = await resolveUserIdForSession(sessionID);
    state = {
      userId,
      runId: sessionID,
      initialized: false,
      memoryCount: 0,
      msgCount: 0,
      systemContext: [],
      stats: {adds: 0, searches: 0, messages: 0},
      dreamTriggered: false,
      dreamWriteSeen: false,
    };
    sessions.set(sessionID, state);
    return state;
  }

  let dreamCleanupDone = false;
  const cleanupDream = () => {
    if (dreamCleanupDone) return;
    dreamCleanupDone = true;
    // Any session that triggered a dream leaves the lock held; release once at
    // process exit. The completion counter is best-effort per session that
    // actually wrote during the dream.
    let anyDream = false;
    for (const state of sessions.values()) {
      if (state.dreamTriggered) {
        anyDream = true;
        if (state.dreamWriteSeen) recordDreamCompletion(mem0StateDir);
      }
    }
    if (anyDream) releaseDreamLock(mem0StateDir);
  };
  try {
    process.on("beforeExit", cleanupDream);
  } catch {
  }

  function readScopeFilters(args: any, state: SessionState): Record<string, unknown> {
    if (args.scope) return scopeSearchFilters(asScope(args.scope), state.userId, state.runId);
    if (args.filters || args.agent_id) return resolveFilters(args, globalSearch, state.userId);
    const ds = loadDefaultScope();
    return ds === "project"
      ? resolveFilters(args, globalSearch, state.userId)
      : scopeSearchFilters(ds, state.userId, state.runId);
  }

  function registerCommands(skillsDir: string, opencodeConfig: any) {
    for (const entry of readdirSync(skillsDir, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const skillMd = resolve(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      let desc = `Mem0 ${entry.name} skill`;
      try {
        const content = readFileSync(skillMd, "utf8");
        const m = content.match(/^description:\s*(.+)$/m);
        if (m) desc = m[1].trim();
      } catch {
      }

      opencodeConfig.command ??= {};
      opencodeConfig.command[entry.name] = {
        template: `Load and execute the \`${entry.name}\` skill.

Use the mem0 memory tools (add_memory, search_memories, get_memories, get_memory, update_memory, delete_memory, delete_all_memories, delete_entities, list_entities) as instructed by the skill.

Identity is resolved per session — call /mem0-status to see the active user_id, run_id, and branch.`,
        description: desc,
      };
    }
  }

  return {
    "chat.message": chatMessageHook,
    "experimental.chat.messages.transform": chatMessagesTransformHook,
    "tool.execute.before": toolExecuteBeforeHook,
    "tool.execute.after": toolExecuteAfterHook,
    "experimental.session.compacting": compactionHook,

    "shell.env": async (
      input: { cwd: string; sessionID?: string },
      output: { env: Record<string, string> },
    ) => {
      if (!output?.env) return;
      const userId = input?.sessionID
        ? (await getSessionState(input.sessionID)).userId
        : projectUserId(project);
      output.env.MEM0_USER_ID = userId;
      if (input?.sessionID) output.env.MEM0_SESSION_ID = input.sessionID;
      output.env.MEM0_BRANCH = branch;
      output.env.MEM0_GLOBAL_SEARCH = globalSearch ? "true" : "false";
    },

    config: async (opencodeConfig: any) => {
      const here = import.meta.filename;
      const skillsDir = [
        resolve(dirname(dirname(here)), "opencode-skills"),
        resolve(dirname(here), "opencode-skills"),
      ].find(existsSync);
      if (!skillsDir) return;

      opencodeConfig.skills ??= {};
      opencodeConfig.skills.paths ??= [];
      if (!opencodeConfig.skills.paths.includes(skillsDir)) {
        opencodeConfig.skills.paths.push(skillsDir);
      }

      registerCommands(skillsDir, opencodeConfig);
    },

    tool: {
      add_memory: tool({
        description: "Add a new memory. This method is called everytime the user informs anything about themselves, their preferences, or anything that has any relevant information which can be useful in the future conversation. This can also be called when the user asks you to remember something. Set infer to false to store the memory verbatim without LLM fact extraction.",
        args: {
          text: tool.schema.string().describe("Memory text content"),
          user_id: tool.schema.string().optional().describe("User ID (defaults to plugin-resolved user_id which already encodes the project)"),
          agent_id: tool.schema.string().optional().describe("Agent ID"),
          metadata: tool.schema.record(tool.schema.string(), tool.schema.any()).optional().describe("Metadata key-value pairs"),
          infer: tool.schema.boolean().optional().describe("Set to false to store memory verbatim without LLM fact extraction"),
          scope: tool.schema.string().optional().describe('Write scope: "project" (this user_id, default), "session" (this run), or "global" (drop user_id, user-wide). Use "global" only when explicitly asked.')
        },
        async execute(args, tctx) {
          const state = await getSessionState(tctx.sessionID);
          state.stats.adds++;
          if (state.dreamTriggered) state.dreamWriteSeen = true;
          const effScope: Scope = args.scope ? asScope(args.scope) : loadDefaultScope();
          const sp = scopeWriteParams(effScope, state.userId, state.runId);
          const finalUserId = args.agent_id ? args.user_id : (args.user_id ?? sp.user_id);

          const meta = args.metadata ?? {};
          if (meta.confidence === undefined) meta.confidence = 0.7;
          if (!meta.source) meta.source = "opencode";
          if (!meta.type) meta.type = "task_learning";
          if (!meta.session_id) meta.session_id = state.runId;
          if (!meta.files) meta.files = ["*"];
          if (!meta.branch) meta.branch = branch;

          let infer = args.infer;
          if (meta.confidence >= 1.0 && infer === undefined) {
            infer = false;
          }

          const res = await mem0.add({
            messages: [{role: "user", content: args.text}],
            user_id: finalUserId,
            run_id: sp.run_id,
            agent_id: args.agent_id,
            metadata: meta,
            infer,
          });
          return JSON.stringify(res);
        }
      }),

      search_memories: tool({
        description: "Search stored memories by semantic meaning. Use this proactively before answering when the request may depend on the user's past work, preferences, decisions, or environment -- relevant memories are not always auto-injected. For multi-part or comparative questions, run several searches with different phrasings and combine the results rather than stopping after one (multi-hop).",
        args: {
          query: tool.schema.string().describe("Search query"),
          user_id: tool.schema.string().optional().describe("User ID (defaults to plugin-resolved user_id)"),
          agent_id: tool.schema.string().optional().describe("Agent ID"),
          filters: tool.schema.record(tool.schema.string(), tool.schema.any()).optional().describe("Extra metadata filters, merged flat onto identity filters"),
          limit: tool.schema.number().optional().describe("Maximum number of results to return (top_k)"),
          top_k: tool.schema.number().optional().describe("Maximum number of results to return (alternative parameter)"),
          scope: tool.schema.string().optional().describe('Search scope: "project" (default), "session" (this run only), or "global" (drop user_id, server-wide). Only use "global" when the user explicitly asks.'),
        },
        async execute(args, tctx) {
          const state = await getSessionState(tctx.sessionID);
          state.stats.searches++;
          const topK = args.limit ?? args.top_k ?? 10;
          const filters = readScopeFilters(args, state);

          const res = await mem0.search({
            query: args.query,
            filters,
            top_k: topK,
          });
          return JSON.stringify(res);
        }
      }),

      get_memories: tool({
        description: "List or browse stored memories without a search query -- useful for auditing what is remembered or paging through everything in a scope. To find memories relevant to a question, use search_memories instead (it ranks by semantic relevance).",
        args: {
          user_id: tool.schema.string().optional().describe("User ID (defaults to plugin-resolved user_id)"),
          agent_id: tool.schema.string().optional().describe("Agent ID"),
          filters: tool.schema.record(tool.schema.string(), tool.schema.any()).optional().describe("Extra metadata filters (informational; the server list endpoint honors identity + top_k only)"),
          page: tool.schema.number().optional().describe("Page number (ignored — server has no pagination)"),
          page_size: tool.schema.number().optional().describe("Page size, mapped to top_k"),
          scope: tool.schema.string().optional().describe('Scope: "project" (default), "session", or "global" (drop user_id, server-wide). Use "global" only when explicitly asked.'),
        },
        async execute(args, tctx) {
          const state = await getSessionState(tctx.sessionID);
          const scoped = readScopeFilters(args, state);
          const res = await mem0.getAll({
            user_id: (scoped.user_id as string) ?? undefined,
            agent_id: (scoped.agent_id as string) ?? undefined,
            run_id: (scoped.run_id as string) ?? undefined,
            top_k: args.page_size,
          });
          return JSON.stringify(res);
        }
      }),

      get_memory: tool({
        description: "Fetch one memory by its exact ID (e.g. an ID returned by search_memories or get_memories) to read its full content and metadata.",
        args: {
          id: tool.schema.string().describe("The ID of the memory to retrieve"),
        },
        async execute(args) {
          const res = await mem0.get(args.id);
          return JSON.stringify(res);
        }
      }),

      update_memory: tool({
        description: "Update an existing memory in place when a stored fact has changed -- requires the memory ID. Preserves the ID and history, so prefer this over deleting and re-adding.",
        args: {
          id: tool.schema.string().describe("The ID of the memory to update"),
          text: tool.schema.string().optional().describe("New text content for the memory"),
          metadata: tool.schema.record(tool.schema.string(), tool.schema.any()).optional().describe("New metadata key-value pairs"),
        },
        async execute(args) {
          const res = await mem0.update(args.id, {
            text: args.text,
            metadata: args.metadata,
          });
          return JSON.stringify(res);
        }
      }),

      delete_memory: tool({
        description: "Delete one or more memories by ID when they are wrong, obsolete, or the user asks to forget them. Irreversible -- only delete what is clearly no longer wanted.",
        args: {
          id: tool.schema.string().describe("The ID of the memory to delete"),
        },
        async execute(args, tctx) {
          const state = await getSessionState(tctx.sessionID);
          if (state.dreamTriggered) state.dreamWriteSeen = true;
          const res = await mem0.delete(args.id);
          return JSON.stringify(res);
        }
      }),

      delete_all_memories: tool({
        description: "Delete ALL memories in the given scope. Destructive and irreversible -- only use when the user explicitly asks to wipe their memory. Never call speculatively.",
        args: {
          user_id: tool.schema.string().optional().describe("User ID whose memories to delete"),
          agent_id: tool.schema.string().optional().describe("Agent ID whose memories to delete"),
          scope: tool.schema.string().optional().describe('Scope to delete: "project" (default), "session", or "global" (user-wide). Use "global" only when explicitly asked.'),
        },
        async execute(args, tctx) {
          const state = await getSessionState(tctx.sessionID);
          if (state.dreamTriggered) state.dreamWriteSeen = true;
          const sp = args.scope ? scopeWriteParams(asScope(args.scope), state.userId, state.runId) : null;
          const res = await mem0.deleteAll({
            user_id: sp ? sp.user_id : (args.agent_id ? args.user_id : (args.user_id ?? state.userId)),
            run_id: sp?.run_id,
            agent_id: args.agent_id,
          });
          return JSON.stringify(res);
        }
      }),

      delete_entities: tool({
        description: "Delete a user/agent/run entity and every memory attached to it. Destructive and irreversible -- only on explicit user request to remove a whole user, agent, or run. Pass EXACTLY ONE of user_id/agent_id/run_id.",
        args: {
          user_id: tool.schema.string().optional().describe("User ID of the entity to delete"),
          agent_id: tool.schema.string().optional().describe("Agent ID of the entity to delete"),
          run_id: tool.schema.string().optional().describe("Run ID of the entity to delete"),
        },
        async execute(args) {
          if (args.user_id) return JSON.stringify(await mem0.deleteEntity("user", args.user_id));
          if (args.agent_id) return JSON.stringify(await mem0.deleteEntity("agent", args.agent_id));
          if (args.run_id) return JSON.stringify(await mem0.deleteEntity("run", args.run_id));
          throw new Error("delete_entities: pass exactly one of user_id / agent_id / run_id");
        }
      }),

      list_entities: tool({
        description: "List the user/agent/run entities that have memories. Use to discover which scopes exist before searching, listing, or deleting within a specific one. `page`/`page_size` slice the result client-side (self-hosted server returns the full list).",
        args: {
          page: tool.schema.number().optional().describe("Page number (1-based, client-side slice)"),
          page_size: tool.schema.number().optional().describe("Page size (default 50, client-side slice)"),
        },
        async execute(args) {
          const all = await mem0.entities();
          const pageSize = args.page_size ?? 50;
          const page = args.page ?? 1;
          const start = (page - 1) * pageSize;
          const results = all.slice(start, start + pageSize);
          return JSON.stringify({results, page, page_size: pageSize, total: all.length});
        }
      }),
    },
  };

  async function chatMessageHook(input: {sessionID: string}, output: any) {
    const userText = extractUserText(input, output);
    if (!userText || userText.length < 10) return;

    const state = await getSessionState(input.sessionID);
    const {userId, runId} = state;
    const safeText = redact(userText);
    state.msgCount++;
    state.stats.messages++;

    if (!state.initialized) {
      state.initialized = true;

      if (dreamConfig.enabled) {
        incrementSessionCount(mem0StateDir, runId);
      }

      const searchFilters: Record<string, unknown> = globalSearch
        ? {}
        : {user_id: userId};

      try {
        const all = await mem0.getAll(globalSearch ? {} : {user_id: userId});
        const a: any = all;
        state.memoryCount =
          typeof a?.count === "number"
            ? a.count
            : Array.isArray(a)
              ? a.length
              : Array.isArray(a?.results)
                ? a.results.length
                : 0;

        if (globalSearch) {
          state.systemContext.push(
            `Global search is ON — searches drop the user_id filter (server-wide). Writes still use user_id="${userId}".`,
          );
        } else {
          state.systemContext.push(
            `Always include user_id="${userId}" in every search_memories filter and add_memory call.`,
          );
        }

        if (state.memoryCount === 0) {
          state.systemContext.push(
            "New project with 0 memories. Capture decisions, conventions, and learnings as you work via the add_memory tool or the remember skill.",
          );
        }

        if (state.memoryCount > 0) {
          state.systemContext.push(
            "Search mem0 for recent decisions and task learnings before responding. Run 2 parallel searches: one for decision type, one for task_learning type.",
          );
          try {
            const res = await mem0.search({
              query: "recent session state decisions and learnings",
              filters: searchFilters,
              top_k: 5,
            });
            state.stats.searches++;
            const memories = extractMemories(res);
            if (memories.length > 0) {
              const memLines = memories
                .map((m) => `- ${m.memory}`)
                .join("\n");
              state.systemContext.push(`Prior context from mem0:\n${memLines}`);
            }
          } catch {
          }
        }

        state.systemContext.push(
          "Mem0 searches apply when user references past work, decision questions, errors, or non-trivial tasks. Queries use noun-phrases, 2-4 parallel calls with different metadata.type filters, and include the current user_id.",
        );
        state.systemContext.push(SCOPE_GUIDANCE);
        const activeScope = loadDefaultScope();
        if (activeScope !== "project") {
          state.systemContext.push(
            `Active default memory scope is "${activeScope}" (set via /mem0-scope). Memory tools use this when no explicit scope is given: "session" limits to this run (run_id="${runId}"); "global" drops user_id from the filter (server-wide). Pass an explicit scope to override per call. delete_all_memories still requires an explicit scope="global" to delete user-wide.`,
          );
        }
      } catch (err: any) {
        try {
          await client.app.log({
            body: {
              service: "mem0",
              level: "error",
              message: `Session init error: ${err?.message}`,
            },
          });
        } catch {
        }
      }

      if (dreamConfig.enabled && dreamConfig.auto && !state.dreamTriggered) {
        const gates = checkCheapGates(mem0StateDir, dreamConfig);
        const memGate = checkMemoryGate(state.memoryCount, dreamConfig);
        if (gates.proceed && memGate.pass && acquireDreamLock(mem0StateDir)) {
          state.dreamTriggered = true;
          state.systemContext.push(DREAM_PROTOCOL);
        } else {
          const waiting = [gates.reason, memGate.reason].filter(Boolean).join("; ");
          if (waiting) {
            try {
              await client.app.log({
                body: {service: "mem0", level: "info", message: `auto-dream waiting — ${waiting}`},
              });
            } catch {
            }
          }
        }
      }
    }

    const hasRemember = NUDGE_RE.test(safeText);
    if (hasRemember) {
      state.systemContext.push(
        "[MEMORY TRIGGER] User asked to remember something. Call add_memory with the user's statement, confidence=1.0, infer=false.",
      );
    }

    const hasResume = RESUME_RE.test(safeText);
    if (hasResume) {
      try {
        const resumeFilters: Record<string, unknown> = globalSearch
          ? {}
          : {user_id: userId};
        const [stateRes, decisionsRes] = await Promise.all([
          mem0.search({query: "session state current task", filters: resumeFilters, top_k: 3}),
          mem0.search({query: "recent decisions and learnings", filters: resumeFilters, top_k: 3}),
        ]);
        state.stats.searches += 2;
        const all = [
          ...extractMemories(stateRes),
          ...extractMemories(decisionsRes),
        ];
        const seen = new Set<string>();
        const unique = all.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
        if (unique.length > 0) {
          const memLines = unique.map((m) => `- ${m.memory}`).join("\n");
          state.systemContext.push(
            `Session resume context:\n${memLines}\n\nThese memories provide context for resuming work.`,
          );
        }
      } catch {
      }
    }

    if (!hasResume && state.memoryCount > 0) {
      try {
        const msgFilters: Record<string, unknown> = globalSearch
          ? {}
          : {user_id: userId};
        const res = await mem0.search({query: safeText, filters: msgFilters, top_k: 5});
        state.stats.searches++;
        const memories = extractMemories(res);
        if (memories.length > 0) {
          const memLines = memories.map((m) => `- ${m.memory}`).join("\n");
          state.systemContext.push(`Relevant memories:\n${memLines}`);
        }
      } catch {
      }
    }

    if (state.msgCount % 3 === 0) {
      Promise.resolve().then(async () => {
        try {
          await mem0.add({
            messages: [{role: "user", content: safeText}],
            user_id: userId,
            run_id: runId,
            metadata: {
              type: "auto_capture",
              source: "opencode",
              confidence: 0.7,
              session_id: runId,
              branch,
            },
            infer: true,
          });
          state.stats.adds++;
        } catch {
        }
      });
    }

    if (state.msgCount % 5 === 0 && state.stats.adds < Math.floor(state.msgCount / 3)) {
      state.systemContext.push(
        "After responding, store any new decisions, learnings, or preferences from this exchange via add_memory. Keep it to 1 sentence per memory.",
      );
    }

  }

  async function toolExecuteBeforeHook(input: any, output: any) {
    const toolName: string = input?.tool ?? "";

    if (WRITE_TOOLS.has(toolName)) {
      const fp = String(
        output?.args?.file_path ?? output?.args?.filePath ?? "",
      );
      if (/MEMORY\.md|\.claude\/memory/i.test(fp)) {
        throw new Error(
          "Use the add_memory tool instead of writing to MEMORY.md",
        );
      }
    }
  }

  async function chatMessagesTransformHook(_input: any, output: { messages: { info: any; parts: any[] }[] }) {
    if (!output?.messages?.length) return;
    // messages.transform has no sessionID in `input`; pull it off the first
    // message's info so we inject the CORRECT session's systemContext when
    // multiple projects share one OpenCode process.
    const sessionID: string | undefined = output.messages[0]?.info?.sessionID;
    if (!sessionID) return;
    const state = sessions.get(sessionID);
    if (!state || state.systemContext.length === 0) return;

    const firstUser = output.messages.find(
      (m) => m.info.role === "user",
    );
    if (!firstUser || !firstUser.parts.length) return;

    const marker = "## Mem0 Memory Context";
    if (firstUser.parts.some((p: any) => p.type === "text" && p.text?.includes(marker))) return;

    const block = `${marker}\n\n${state.systemContext.join("\n\n")}`;
    const ref = firstUser.parts[0];
    firstUser.parts.unshift({...ref, type: "text", text: block});
  }

  async function toolExecuteAfterHook(input: any, _output: any) {
    const toolName: string = input?.tool ?? "";
    const toolOutput: string = input?.output ?? _output?.output ?? "";
    const sessionID: string | undefined = input?.sessionID;
    if (!sessionID) return;

    if (toolName === "bash" && toolOutput.length >= 50) {
      const command: string = input?.args?.command ?? "";
      if (/git\s+(commit|merge|rebase)/.test(command)) return;

      const hasStrongError = ERROR_STRONG_RE.test(toolOutput);
      const multiErrors = (toolOutput.match(ERROR_MULTI_RE) ?? []).length;
      if (!hasStrongError && multiErrors < 2) return;

      try {
        const state = await getSessionState(sessionID);
        const errorLine =
          toolOutput
            .split("\n")
            .find((l: string) =>
              /Error:|Exception:|panic:|FAIL:|fatal:/i.test(l),
            )
            ?.replace(/^\s+/, "")
            .slice(0, 120) ?? "";

        const traceFiles = [
          ...new Set(
            toolOutput.match(
              /[a-zA-Z0-9_./-]+\.(py|ts|tsx|js|jsx|rs|go|rb|java|sh)(:\d+)?/g,
            ) ?? [],
          ),
        ].slice(0, 5);

        const errorQuery = errorLine.slice(0, 80);
        if (errorQuery.length < 10) return;

        const errorFilters: Record<string, unknown> = globalSearch
          ? {}
          : {user_id: state.userId};
        const res = await mem0.search({
          query: `error: ${errorQuery}`,
          filters: errorFilters,
          top_k: 6,
        });
        state.stats.searches++;
        const unique = extractMemories(res);

        let ctx = `Error detected: \`${command.slice(0, 100)}\` produced:\n> ${errorLine}`;
        if (traceFiles.length > 0) {
          ctx += `\nFiles in stack trace: ${traceFiles.join(", ")}`;
        }
        if (unique.length > 0) {
          const lines = unique.map((m) => `- ${m.memory}`).join("\n");
          ctx += `\nPrior error memories:\n${lines}`;
        }
        ctx +=
          "\nStore resolved errors as anti_pattern or bug_fix memories for future reference.";
        state.systemContext.push(ctx);
      } catch {
      }
    }
  }

  async function compactionHook(input: { sessionID?: string }, output: { context: string[]; prompt?: string }) {
    const sessionID = input?.sessionID;
    if (!sessionID) return;
    try {
      const state = await getSessionState(sessionID);
      const {userId, runId, stats} = state;
      const summaryContent = `Session compacting. User: ${userId}. Branch: ${branch}. Session: ${runId}. Stats: ${stats.adds} memories stored, ${stats.searches} searches, ${stats.messages} messages.`;
      Promise.resolve().then(async () => {
        try {
          await mem0.add({
            messages: [{role: "user", content: summaryContent}],
            user_id: userId,
            run_id: runId,
            metadata: {
              type: "session_state",
              source: "pre-compaction",
              session_id: runId,
              branch,
            },
            infer: true,
          });
        } catch {
        }
      });

      const compactFilters: Record<string, unknown> = globalSearch
        ? {}
        : {user_id: userId};
      const res = await mem0.search({
        query: "session state decisions learnings",
        filters: compactFilters,
        top_k: 10,
      });
      const memories = extractMemories(res);
      if (memories.length > 0 && output?.context) {
        const lines = memories.map((m) => `- ${m.memory}`).join("\n");
        output.context.push(
          `## Mem0 Memories (preserve across compaction)\n\n${lines}\n\nIMPORTANT: After compaction, store any key decisions or learnings using the add_memory tool.`,
        );
      }
    } catch {
    }
  }
};

export default Mem0Plugin;
