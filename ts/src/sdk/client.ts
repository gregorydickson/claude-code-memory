/**
 * MemoryGraph Cloud API client.
 *
 * TypeScript/Bun port of the Python `MemoryGraphClient` and
 * `AsyncMemoryGraphClient`. Since JavaScript is async-native, a single
 * client class is provided that uses native `fetch` and async/await.
 *
 * Usage:
 *   import { MemoryGraphClient } from "./sdk/index.ts";
 *
 *   const client = new MemoryGraphClient({ apiKey: "mgraph_..." });
 *   const memory = await client.createMemory({
 *     type: "solution",
 *     title: "Fixed timeout with retry",
 *     content: "...",
 *     tags: ["redis", "timeout"],
 *   });
 *
 *   // Disposable-style usage (manual close):
 *   try {
 *     const memories = await client.searchMemories({ query: "redis" });
 *   } finally {
 *     client.close();
 *   }
 */

import type { Memory, MemoryCreate, MemoryUpdate, RelatedMemory, Relationship, RelationshipCreate } from "./models.ts";
import {
  AuthenticationError,
  MemoryGraphError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from "./exceptions.ts";

export interface MemoryGraphClientOptions {
  /** MemoryGraph API key (starts with 'mgraph_'). Falls back to MEMORYGRAPH_API_KEY env var. */
  apiKey?: string;
  /** Base URL for the API. Default: https://api.memorygraph.dev */
  apiUrl?: string;
  /** Request timeout in milliseconds. Default: 30000 */
  timeout?: number;
}

export interface CreateMemoryParams {
  type: string;
  title: string;
  content: string;
  tags?: string[];
  importance?: number;
  context?: Record<string, unknown>;
  summary?: string;
}

export interface UpdateMemoryParams {
  title?: string;
  content?: string;
  tags?: string[];
  importance?: number;
  summary?: string;
}

export interface SearchMemoriesParams {
  query?: string;
  memory_types?: string[];
  tags?: string[];
  min_importance?: number;
  limit?: number;
  offset?: number;
}

export interface RecallMemoriesParams {
  query: string;
  memory_types?: string[];
  project_path?: string;
  limit?: number;
}

export interface CreateRelationshipParams {
  from_memory_id: string;
  to_memory_id: string;
  relationship_type: string;
  strength?: number;
  confidence?: number;
  context?: string;
}

export interface GetRelatedMemoriesParams {
  relationship_types?: string[];
  max_depth?: number;
}

const DEFAULT_API_URL = "https://api.memorygraph.dev";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Client for the MemoryGraph Cloud API.
 *
 * All methods are async and return native promises. Use `close()` to free
 * resources; in JS there are no persistent HTTP connections to close when
 * using `fetch`, but `close()` is provided for API parity and marks the
 * client as disposed so further calls throw.
 */
export class MemoryGraphClient {
  private readonly _apiKey: string;
  readonly apiUrl: string;
  readonly timeout: number;
  private disposed = false;

  constructor(options: MemoryGraphClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.MEMORYGRAPH_API_KEY;
    if (!apiKey) {
      throw new AuthenticationError(
        "API key required. Provide via apiKey option or MEMORYGRAPH_API_KEY environment variable."
      );
    }

    this._apiKey = apiKey;
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  // -- Memory operations --

  /** Create a new memory. */
  async createMemory(params: CreateMemoryParams): Promise<Memory> {
    const payload: MemoryCreate = {
      type: params.type,
      title: params.title,
      content: params.content,
      tags: params.tags ?? [],
      importance: params.importance ?? 0.5,
    };
    if (params.context !== undefined) payload.context = params.context;
    if (params.summary !== undefined) payload.summary = params.summary;

    const data = await this.request("POST", "/api/v1/memories", payload);
    return data as unknown as Memory;
  }

  /** Get a memory by ID. */
  async getMemory(memoryId: string, includeRelationships = true): Promise<Memory> {
    const params: Record<string, string> = {
      include_relationships: String(includeRelationships),
    };
    const data = await this.request("GET", `/api/v1/memories/${encodeURIComponent(memoryId)}`, undefined, params);
    return data as unknown as Memory;
  }

  /** Update an existing memory. */
  async updateMemory(memoryId: string, params: UpdateMemoryParams): Promise<Memory> {
    const payload: MemoryUpdate = {};
    if (params.title !== undefined) payload.title = params.title;
    if (params.content !== undefined) payload.content = params.content;
    if (params.tags !== undefined) payload.tags = params.tags;
    if (params.importance !== undefined) payload.importance = params.importance;
    if (params.summary !== undefined) payload.summary = params.summary;

    const data = await this.request("PATCH", `/api/v1/memories/${encodeURIComponent(memoryId)}`, payload);
    return data as unknown as Memory;
  }

  /** Delete a memory and its relationships. Returns true on success. */
  async deleteMemory(memoryId: string): Promise<boolean> {
    await this.request("DELETE", `/api/v1/memories/${encodeURIComponent(memoryId)}`);
    return true;
  }

  /** Search for memories. */
  async searchMemories(params: SearchMemoriesParams = {}): Promise<Memory[]> {
    const query: Record<string, string> = {
      limit: String(params.limit ?? 20),
      offset: String(params.offset ?? 0),
    };
    if (params.query !== undefined) query.query = params.query;
    if (params.memory_types && params.memory_types.length > 0) {
      query.memory_types = params.memory_types.join(",");
    }
    if (params.tags && params.tags.length > 0) {
      query.tags = params.tags.join(",");
    }
    if (params.min_importance !== undefined) {
      query.min_importance = String(params.min_importance);
    }

    const data = await this.request("GET", "/api/v1/memories", undefined, query);
    const memories = (data as { memories?: unknown[] }).memories ?? [];
    return memories as Memory[];
  }

  /** Recall memories using a natural language query. */
  async recallMemories(params: RecallMemoriesParams): Promise<Memory[]> {
    const query: Record<string, string> = {
      query: params.query,
      limit: String(params.limit ?? 20),
    };
    if (params.memory_types && params.memory_types.length > 0) {
      query.memory_types = params.memory_types.join(",");
    }
    if (params.project_path !== undefined) {
      query.project_path = params.project_path;
    }

    const data = await this.request("GET", "/api/v1/memories/recall", undefined, query);
    const memories = (data as { memories?: unknown[] }).memories ?? [];
    return memories as Memory[];
  }

  // -- Relationship operations --

  /** Create a relationship between two memories. */
  async createRelationship(params: CreateRelationshipParams): Promise<Relationship> {
    const payload: RelationshipCreate = {
      from_memory_id: params.from_memory_id,
      to_memory_id: params.to_memory_id,
      relationship_type: params.relationship_type,
      strength: params.strength ?? 0.5,
      confidence: params.confidence ?? 0.8,
    };
    if (params.context !== undefined) payload.context = params.context;

    const data = await this.request("POST", "/api/v1/relationships", payload);
    return data as unknown as Relationship;
  }

  /** Get memories related to a specific memory. */
  async getRelatedMemories(memoryId: string, params: GetRelatedMemoriesParams = {}): Promise<RelatedMemory[]> {
    const query: Record<string, string> = {
      max_depth: String(params.max_depth ?? 1),
    };
    if (params.relationship_types && params.relationship_types.length > 0) {
      query.relationship_types = params.relationship_types.join(",");
    }

    const data = await this.request(
      "GET",
      `/api/v1/memories/${encodeURIComponent(memoryId)}/related`,
      undefined,
      query
    );
    const related = (data as { related?: unknown[] }).related ?? [];
    return related as unknown as RelatedMemory[];
  }

  // -- Lifecycle --

  /** Close the client. Subsequent calls will throw. */
  close(): void {
    this.disposed = true;
  }

  /** Whether the client has been closed. */
  get closed(): boolean {
    return this.disposed;
  }

  // -- Internals --

  private ensureOpen(): void {
    if (this.disposed) {
      throw new MemoryGraphError("Client has been closed");
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this._apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string>
  ): Promise<Record<string, unknown>> {
    this.ensureOpen();

    let url = `${this.apiUrl}${path}`;
    if (params && Object.keys(params).length > 0) {
      const search = new URLSearchParams(params);
      url += `?${search.toString()}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new ServerError(`Request timeout after ${this.timeout}ms`);
      }
      throw new MemoryGraphError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    clearTimeout(timeoutId);
    await this.checkResponse(response);

    if (response.status === 204) return {};

    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Non-JSON response; return as opaque payload
      return { raw: text };
    }
  }

  /**
   * Check response status and throw an appropriate exception on error.
   * Reads the response body only when the status indicates an error.
   */
  private async checkResponse(response: Response): Promise<void> {
    if (response.status < 400) return;

    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      bodyText = "";
    }
    const detail = bodyText || response.statusText;
    const status = response.status;

    if (status === 401) {
      throw new AuthenticationError("Invalid API key");
    }
    if (status === 404) {
      throw new NotFoundError(`Resource not found: ${detail}`);
    }
    if (status === 429) {
      throw new RateLimitError("Rate limit exceeded. Please retry later.");
    }
    if (status === 400) {
      throw new ValidationError(`Validation error: ${detail}`);
    }
    if (status >= 500) {
      throw new ServerError(`Server error: ${status} - ${detail}`);
    }
    throw new MemoryGraphError(`API error: ${status} - ${detail}`, status);
  }
}
