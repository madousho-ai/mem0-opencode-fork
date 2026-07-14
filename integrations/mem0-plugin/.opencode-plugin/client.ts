/**
 * Mem0HttpClient — thin HTTP wrapper for the self-hosted mem0 FastAPI server
 * (mem0-opencode-fork/server/).
 *
 * Replaces the cloud `MemoryClient` from the `mem0ai` npm SDK: the cloud SDK
 * targets `api.mem0.ai/v1/*` and platform-only features (custom categories,
 * async event queue, AND/OR filters, `app_id`) that the self-hosted server
 * (a thin wrapper around the mem0 OSS `Memory` class) does not implement.
 *
 * Endpoints covered (see server/main.py, server/routers/entities.py):
 *   POST   /memories                       add
 *   GET    /memories                       list (top_k, user_id/agent_id/run_id)
 *   GET    /memories/{id}                  fetch one
 *   PUT    /memories/{id}                  update text/metadata
 *   DELETE /memories/{id}                  delete one
 *   DELETE /memories?user_id=&agent_id=... delete-all (admin)
 *   GET    /memories/{id}/history          change history
 *   POST   /search                         semantic search
 *   GET    /entities                       list users/agents/runs (no pagination)
 *   DELETE /entities/{type}/{id}           cascade delete an entity (admin)
 *
 * Auth: `X-API-Key: <key>` when `apiKey` is set. When empty (e.g. server started
 * with AUTH_DISABLED=true), no auth header is sent.
 */

export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface MemoryAddParams {
  messages: ChatMessage[];
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  metadata?: Record<string, unknown>;
  infer?: boolean;
  memory_type?: string;
  expiration_date?: string;
}

export interface MemorySearchParams {
  query: string;
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  filters?: Record<string, unknown>;
  top_k?: number;
  threshold?: number;
}

export interface MemoryListParams {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  top_k?: number;
}

export interface MemoryUpdateBody {
  text?: string;
  metadata?: Record<string, unknown>;
  expiration_date?: string;
}

export interface MemoryDeleteAllParams {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
}

export type EntityType = "user" | "agent" | "run";

export class Mem0HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(baseUrl: string, apiKey?: string) {
    if (!baseUrl) {
      throw new Error("Mem0HttpClient: baseUrl is required");
    }
    // Strip trailing slashes so we can concatenate `${baseUrl}${path}` safely.
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey && apiKey.length > 0 ? apiKey : undefined;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {"Content-Type": "application/json"};
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    return headers;
  }

  private buildQuery(query?: Record<string, unknown>): string {
    if (!query) return "";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  }

  private async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}${this.buildQuery(query)}`;
    const res = await fetch(url, {
      method,
      headers: this.buildHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Mem0 ${method} ${path} failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
      );
    }
    // Some endpoints (e.g. DELETE /memories/{id}) return a JSON message; a
    // handful may return an empty body. Fall back to `null` on empty responses.
    const text = await res.text();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** POST /memories — create memories from a chat-message list. */
  add(params: MemoryAddParams): Promise<any> {
    return this.request("POST", "/memories", params);
  }

  /** POST /search — semantic search with optional filters. */
  search(params: MemorySearchParams): Promise<any> {
    return this.request("POST", "/search", params);
  }

  /** GET /memories — list memories in a scope (top_k caps the result set). */
  getAll(params: MemoryListParams = {}): Promise<any> {
    return this.request("GET", "/memories", undefined, params as Record<string, unknown>);
  }

  /** GET /memories/{id} — fetch one memory by id. */
  get(id: string): Promise<any> {
    return this.request("GET", `/memories/${encodeURIComponent(id)}`);
  }

  /** PUT /memories/{id} — update text / metadata / expiration. */
  update(id: string, body: MemoryUpdateBody): Promise<any> {
    return this.request("PUT", `/memories/${encodeURIComponent(id)}`, body);
  }

  /** DELETE /memories/{id} — remove a single memory. */
  delete(id: string): Promise<any> {
    return this.request("DELETE", `/memories/${encodeURIComponent(id)}`);
  }

  /** DELETE /memories?... — bulk delete within a scope (server requires admin). */
  deleteAll(params: MemoryDeleteAllParams): Promise<any> {
    return this.request("DELETE", "/memories", undefined, params as Record<string, unknown>);
  }

  /** GET /memories/{id}/history — return the change log for a memory. */
  history(id: string): Promise<any> {
    return this.request("GET", `/memories/${encodeURIComponent(id)}/history`);
  }

  /** GET /entities — list every user/agent/run with stored memories (no server-side pagination). */
  entities(): Promise<any[]> {
    return this.request<any[]>("GET", "/entities");
  }

  /** DELETE /entities/{type}/{id} — cascade delete every memory attached to an entity (admin). */
  deleteEntity(type: EntityType, id: string): Promise<any> {
    return this.request(
      "DELETE",
      `/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    );
  }
}
