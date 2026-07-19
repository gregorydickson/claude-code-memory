/**
 * Cloud backend for MemoryGraph.
 *
 * Communicates with the MemoryGraph Cloud API, enabling multi-device sync,
 * team collaboration, and cloud-based memory storage.
 */

import { Config } from "../config.ts";
import {
  type Memory,
  type Relationship,
  type RelationshipProperties,
  type SearchQuery,
} from "../models.ts";
import {
  type GraphBackend,
  type HealthCheckResult,
} from "./base.ts";
import {
  DatabaseConnectionError,
  MemoryNotFoundError,
  ValidationError,
} from "../errors.ts";

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  failureThreshold: number;
  recoveryTimeout: number;
  failureCount = 0;
  lastFailureTime: number | null = null;
  state: "closed" | "open" | "half_open" = "closed";
  private lock = Promise.resolve();

  constructor(failureThreshold = 5, recoveryTimeout = 60.0) {
    this.failureThreshold = failureThreshold;
    this.recoveryTimeout = recoveryTimeout;
  }

  async canExecute(): Promise<boolean> {
    return this.runLocked(() => {
      if (this.state === "closed") return true;
      if (this.state === "open") {
        if (this.lastFailureTime && Date.now() / 1000 - this.lastFailureTime >= this.recoveryTimeout) {
          this.state = "half_open";
          return true;
        }
        return false;
      }
      return true; // half_open
    });
  }

  async recordSuccess(): Promise<void> {
    return this.runLocked(() => {
      this.failureCount = 0;
      this.lastFailureTime = null;
      this.state = "closed";
    });
  }

  async recordFailure(): Promise<void> {
    return this.runLocked(() => {
      this.failureCount++;
      this.lastFailureTime = Date.now() / 1000;
      if (this.state === "half_open") {
        this.state = "open";
      } else if (this.failureCount >= this.failureThreshold) {
        this.state = "open";
      }
    });
  }

  private async runLocked<T>(fn: () => T): Promise<T> {
    const prev = this.lock;
    let resolve: () => void;
    this.lock = new Promise((r) => (resolve = r));
    await prev;
    try {
      return fn();
    } finally {
      resolve!();
    }
  }
}

// ---------------------------------------------------------------------------
// Cloud backend errors
// ---------------------------------------------------------------------------

export class CloudBackendError extends Error {}
export class AuthenticationError extends CloudBackendError {}
export class UsageLimitExceeded extends CloudBackendError {}
export class RateLimitExceeded extends CloudBackendError {
  retryAfter?: number;
  constructor(message: string, retryAfter?: number) {
    super(message);
    this.retryAfter = retryAfter;
  }
}
export class CircuitBreakerOpenError extends CloudBackendError {}

// ---------------------------------------------------------------------------
// Cloud REST adapter
// ---------------------------------------------------------------------------

export class CloudRESTAdapter implements GraphBackend {
  DEFAULT_API_URL = "https://graph-api.memorygraph.dev";
  DEFAULT_TIMEOUT = 30;

  apiKey: string;
  apiUrl: string;
  timeout: number;
  private _connected = false;
  private circuitBreaker: CircuitBreaker;

  constructor(apiKey?: string, apiUrl?: string, timeout?: number) {
    this.apiKey = apiKey ?? Config.MEMORYGRAPH_API_KEY ?? "";
    this.apiUrl = (apiUrl ?? Config.MEMORYGRAPH_API_URL ?? this.DEFAULT_API_URL).replace(/\/$/, "");
    this.timeout = timeout ?? Config.MEMORYGRAPH_TIMEOUT;

    if (!this.apiKey) {
      throw new DatabaseConnectionError(
        "MEMORYGRAPH_API_KEY is required for cloud backend. " +
          "Get your API key at https://app.memorygraph.dev"
      );
    }

    if (!this.apiKey.startsWith("mg_")) {
      console.warn(
        `API key does not start with 'mg_' prefix. Ensure you're using a valid MemoryGraph API key.`
      );
    }

    this.circuitBreaker = new CircuitBreaker(
      Config.CLOUD_CIRCUIT_BREAKER_THRESHOLD,
      Config.CLOUD_CIRCUIT_BREAKER_TIMEOUT
    );
  }

  private getHeaders(): Record<string, string> {
    return {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
      "User-Agent": "memorygraph-ts/1.0",
    };
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string>,
    retryCount = 0
  ): Promise<Record<string, unknown>> {
    if (!(await this.circuitBreaker.canExecute())) {
      throw new CircuitBreakerOpenError(
        `Circuit breaker is open due to repeated failures. Will retry in ${this.circuitBreaker.recoveryTimeout} seconds.`
      );
    }

    let url = `${this.apiUrl}${path}`;
    if (params) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout * 1000);

      const response = await fetch(url, {
        method,
        headers: this.getHeaders(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 401) {
        throw new AuthenticationError("Invalid API key. Get a valid key at https://app.memorygraph.dev");
      }
      if (response.status === 403) {
        const errorData = await response.json().catch(() => ({}));
        throw new UsageLimitExceeded(
          (errorData as Record<string, unknown>)["detail"] as string ??
            "Usage limit exceeded. Upgrade at https://app.memorygraph.dev/pricing"
        );
      }
      if (response.status === 404) {
        throw new MemoryNotFoundError(`Resource not found: ${path}`);
      }
      if (response.status === 413) {
        throw new ValidationError("Payload too large. Please reduce the size of your content.");
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        throw new RateLimitExceeded(
          "Rate limit exceeded. Please slow down requests.",
          retryAfter ? Number.parseInt(retryAfter, 10) : undefined
        );
      }
      if (response.status >= 500) {
        return this.retryOrRaise(
          `Graph API server error after ${Config.CLOUD_MAX_RETRIES} retries: ${response.status}`,
          method,
          path,
          body,
          params,
          retryCount,
          `Server error ${response.status}`
        );
      }

      if (!response.ok) {
        throw new DatabaseConnectionError(`HTTP error: ${response.status} ${response.statusText}`);
      }

      if (response.status === 204) {
        await this.circuitBreaker.recordSuccess();
        return {};
      }
      const json = (await response.json()) as Record<string, unknown>;
      await this.circuitBreaker.recordSuccess();
      return json;
    } catch (err) {
      if (
        err instanceof AuthenticationError ||
        err instanceof UsageLimitExceeded ||
        err instanceof RateLimitExceeded ||
        err instanceof MemoryNotFoundError
      ) {
        throw err;
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        return this.retryOrRaise(
          `Request timeout after ${Config.CLOUD_MAX_RETRIES} retries`,
          method,
          path,
          body,
          params,
          retryCount,
          "Request timeout"
        );
      }
      if (err instanceof TypeError) {
        // Network/connection error
        return this.retryOrRaise(
          `Cannot connect to Graph API at ${this.apiUrl}: ${err}`,
          method,
          path,
          body,
          params,
          retryCount,
          "Connection error"
        );
      }
      throw new DatabaseConnectionError(`Unexpected error: ${err}`);
    }
  }

  private async retryOrRaise(
    errorMessage: string,
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    params: Record<string, string> | undefined,
    retryCount: number,
    logPrefix: string
  ): Promise<Record<string, unknown>> {
    await this.circuitBreaker.recordFailure();
    if (retryCount < Config.CLOUD_MAX_RETRIES) {
      const backoff = Config.CLOUD_RETRY_BACKOFF_BASE * 2 ** retryCount;
      console.warn(
        `${logPrefix}, retrying in ${backoff}s (attempt ${retryCount + 1}/${Config.CLOUD_MAX_RETRIES})`
      );
      await new Promise((resolve) => setTimeout(resolve, backoff * 1000));
      return this.request(method, path, body, params, retryCount + 1);
    }
    throw new DatabaseConnectionError(errorMessage);
  }

  // -- GraphBackend interface --

  async connect(): Promise<boolean> {
    try {
      console.log(`Connecting to MemoryGraph Cloud at ${this.apiUrl}...`);
      const result = await this.request("GET", "/health");
      if (result && result["status"] === "healthy") {
        this._connected = true;
        console.log("Successfully connected to MemoryGraph Cloud");
        return true;
      }
      throw new DatabaseConnectionError(`Health check failed: ${JSON.stringify(result)}`);
    } catch (err) {
      if (err instanceof AuthenticationError) throw err;
      throw new DatabaseConnectionError(`Failed to connect to cloud: ${err}`);
    }
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    console.log("Disconnected from MemoryGraph Cloud");
  }

  async executeQuery(
    _query: string,
    _parameters?: Record<string, unknown>,
    _write?: boolean
  ): Promise<Record<string, unknown>[]> {
    throw new Error(
      "Cloud backend does not support raw Cypher queries. Use storeMemory(), searchMemories(), etc. instead."
    );
  }

  async initializeSchema(): Promise<void> {
    // No-op; schema managed by cloud service
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const result = await this.request("GET", "/health");
      return {
        connected: true,
        backend_type: "cloud",
        api_url: this.apiUrl,
        status: (result["status"] as string) ?? "unknown",
        version: (result["version"] as string) ?? "unknown",
      };
    } catch (err) {
      return {
        connected: false,
        backend_type: "cloud",
        api_url: this.apiUrl,
        error: String(err),
      };
    }
  }

  backendName(): string {
    return "cloud";
  }
  supportsFulltextSearch(): boolean {
    return true;
  }
  supportsTransactions(): boolean {
    return true;
  }
  isCypherCapable(): boolean {
    return false;
  }

  // -- Memory operations --

  async storeMemory(memory: Memory): Promise<string> {
    const payload = this.memoryToApiPayload(memory);
    const result = await this.request("POST", "/memories", payload);
    const memoryId = (result["id"] as string) ?? (result["memory_id"] as string);
    console.log(`Stored memory in cloud: ${memoryId}`);
    return memoryId;
  }

  async getMemory(memoryId: string, _includeRelationships = true): Promise<Memory | null> {
    try {
      const result = await this.request("GET", `/memories/${encodeURIComponent(memoryId)}`);
      return this.apiResponseToMemory(result);
    } catch (err) {
      if (err instanceof MemoryNotFoundError) return null;
      throw err;
    }
  }

  async searchMemories(searchQuery: SearchQuery): Promise<Memory[]> {
    const payload: Record<string, unknown> = {};
    if (searchQuery.query) payload["query"] = searchQuery.query;
    if (searchQuery.memory_types.length > 0) payload["memory_types"] = searchQuery.memory_types;
    if (searchQuery.tags.length > 0) payload["tags"] = searchQuery.tags;
    if (searchQuery.project_path) payload["project_path"] = searchQuery.project_path;
    if (searchQuery.min_importance !== undefined && searchQuery.min_importance !== null)
      payload["min_importance"] = searchQuery.min_importance;
    if (searchQuery.limit) payload["limit"] = searchQuery.limit;
    if (searchQuery.offset) payload["offset"] = searchQuery.offset;

    const result = await this.request("POST", "/search/advanced", payload);
    const items = (result["memories"] as Record<string, unknown>[]) ?? (result["results"] as Record<string, unknown>[]) ?? [];
    const memories: Memory[] = [];
    for (const item of items) {
      const mem = this.apiResponseToMemory(item);
      if (mem) memories.push(mem);
    }
    console.log(`Cloud search returned ${memories.length} memories`);
    return memories;
  }

  async recallMemories(
    query: string,
    opts?: { memoryTypes?: string[]; projectPath?: string; limit?: number }
  ): Promise<Memory[]> {
    const payload: Record<string, unknown> = { query, limit: opts?.limit ?? 20 };
    if (opts?.memoryTypes) payload["memory_types"] = opts.memoryTypes;
    if (opts?.projectPath) payload["project_path"] = opts.projectPath;

    const result = await this.request("POST", "/search/recall", payload);
    const items = (result["memories"] as Record<string, unknown>[]) ?? (result["results"] as Record<string, unknown>[]) ?? [];
    const memories: Memory[] = [];
    for (const item of items) {
      const mem = this.apiResponseToMemory(item);
      if (mem) memories.push(mem);
    }
    return memories;
  }

  async updateMemory(memory: Memory): Promise<boolean> {
    if (!memory.id) throw new ValidationError("Memory must have an ID to update");
    const updates: Record<string, unknown> = {
      title: memory.title,
      content: memory.content,
      summary: memory.summary,
      tags: memory.tags,
      importance: memory.importance,
    };
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === undefined) delete updates[k];
    }
    try {
      const result = await this.request("PUT", `/memories/${encodeURIComponent(memory.id)}`, updates);
      return result !== null;
    } catch (err) {
      if (err instanceof MemoryNotFoundError) return false;
      throw err;
    }
  }

  async deleteMemory(memoryId: string): Promise<boolean> {
    try {
      await this.request("DELETE", `/memories/${encodeURIComponent(memoryId)}`);
      console.log(`Deleted memory from cloud: ${memoryId}`);
      return true;
    } catch (err) {
      if (err instanceof MemoryNotFoundError) return false;
      throw err;
    }
  }

  // -- Relationship operations --

  async createRelationship(
    fromMemoryId: string,
    toMemoryId: string,
    relationshipType: string,
    properties?: RelationshipProperties
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      from_memory_id: fromMemoryId,
      to_memory_id: toMemoryId,
      relationship_type: relationshipType,
    };
    if (properties) {
      payload["strength"] = properties.strength;
      payload["confidence"] = properties.confidence;
      if (properties.context) payload["context"] = properties.context;
    }
    const result = await this.request("POST", "/relationships", payload);
    const relId = (result["id"] as string) ?? (result["relationship_id"] as string);
    console.log(`Created relationship in cloud: ${fromMemoryId} -[${relationshipType}]-> ${toMemoryId}`);
    return relId;
  }

  async getRelatedMemories(
    memoryId: string,
    opts?: { relationshipTypes?: string[]; maxDepth?: number }
  ): Promise<[Memory, Relationship][]> {
    const params: Record<string, string> = { max_depth: String(opts?.maxDepth ?? 1) };
    if (opts?.relationshipTypes && opts.relationshipTypes.length > 0) {
      params["relationship_types"] = opts.relationshipTypes.join(",");
    }

    try {
      const result = await this.request("GET", `/search/memories/${encodeURIComponent(memoryId)}/related`, undefined, params);
      if (!result) return [];
      const relatedMemories: [Memory, Relationship][] = [];
      const items = (result["related_memories"] as Record<string, unknown>[]) ?? [];
      for (const item of items) {
        const mem = this.apiResponseToMemory((item["memory"] as Record<string, unknown>) ?? item);
        if (!mem) continue;

        const relData = (item["relationship"] as Record<string, unknown>) ?? {};
        const rel: Relationship = {
          id: null,
          from_memory_id: memoryId,
          to_memory_id: mem.id!,
          type: (relData["type"] as string) ?? "RELATED_TO",
          properties: {
            strength: (relData["strength"] as number) ?? 0.5,
            confidence: (relData["confidence"] as number) ?? 0.8,
            context: (relData["context"] as string) ?? undefined,
            evidence_count: 1,
            success_rate: undefined,
            created_at: new Date().toISOString(),
            last_validated: new Date().toISOString(),
            validation_count: 0,
            counter_evidence_count: 0,
            valid_from: new Date().toISOString(),
            valid_until: undefined,
            recorded_at: new Date().toISOString(),
            invalidated_by: undefined,
          },
          description: undefined,
          bidirectional: false,
        };
        relatedMemories.push([mem, rel]);
      }
      return relatedMemories;
    } catch (err) {
      if (err instanceof MemoryNotFoundError) return [];
      throw err;
    }
  }

  async getMemoryStatistics(): Promise<Record<string, unknown>> {
    const result = await this.request("GET", "/graphs/statistics");
    return result ?? {};
  }

  async getRecentActivity(days = 7, project?: string | null): Promise<Record<string, unknown>> {
    const params: Record<string, string> = { days: String(days) };
    if (project) params["project"] = project;
    const result = await this.request("GET", "/memories/recent", undefined, params);
    if (!result) {
      return {
        total_count: 0,
        memories_by_type: {},
        recent_memories: [],
        unresolved_problems: [],
        days,
        project,
      };
    }

    const recentMemories: Memory[] = [];
    const recentItems = (result["recent_memories"] as Record<string, unknown>[]) ?? [];
    for (const item of recentItems) {
      const mem = this.apiResponseToMemory(item);
      if (mem) recentMemories.push(mem);
    }

    const unresolvedProblems: Memory[] = [];
    const unresolvedItems = (result["unresolved_problems"] as Record<string, unknown>[]) ?? [];
    for (const item of unresolvedItems) {
      const mem = this.apiResponseToMemory(item);
      if (mem) unresolvedProblems.push(mem);
    }

    return {
      total_count: (result["total_count"] as number) ?? 0,
      memories_by_type: (result["memories_by_type"] as Record<string, number>) ?? {},
      recent_memories: recentMemories,
      unresolved_problems: unresolvedProblems,
      days: (result["days"] as number) ?? days,
      project: (result["project"] as string) ?? project,
    };
  }

  // -- Helpers --

  private memoryToApiPayload(memory: Memory): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      type: memory.type,
      title: memory.title,
      content: memory.content,
    };
    if (memory.id) payload["id"] = memory.id;
    if (memory.summary) payload["summary"] = memory.summary;
    if (memory.tags.length > 0) payload["tags"] = memory.tags;
    if (memory.importance !== undefined) payload["importance"] = memory.importance;
    if (memory.confidence !== undefined) payload["confidence"] = memory.confidence;
    if (memory.context) {
      const contextFields = [
        "project_path", "files_involved", "languages", "frameworks",
        "technologies", "git_commit", "git_branch", "working_directory",
        "additional_metadata",
      ];
      const contextDict: Record<string, unknown> = {};
      for (const field of contextFields) {
        const value = (memory.context as Record<string, unknown>)[field];
        if (value) contextDict[field] = value;
      }
      if (Object.keys(contextDict).length > 0) payload["context"] = contextDict;
    }
    return payload;
  }

  private static parseTimestamp(value: unknown, fallback?: string): string {
    if (typeof value === "string") return value;
    if (value instanceof Date) return value.toISOString();
    return fallback ?? new Date().toISOString();
  }

  private apiResponseToMemory(data: Record<string, unknown>): Memory | null {
    try {
      const typeStr = (data["type"] as string) ?? "general";
      const createdAt = CloudRESTAdapter.parseTimestamp(data["created_at"]);
      const updatedAt = CloudRESTAdapter.parseTimestamp(data["updated_at"], createdAt);

      let context: Record<string, unknown> | undefined;
      const contextData = data["context"];
      if (contextData && typeof contextData === "object") {
        const ctx = contextData as Record<string, unknown>;
        context = {
          project_path: ctx["project_path"],
          files_involved: (ctx["files_involved"] as string[]) ?? [],
          languages: (ctx["languages"] as string[]) ?? [],
          frameworks: (ctx["frameworks"] as string[]) ?? [],
          technologies: (ctx["technologies"] as string[]) ?? [],
          git_commit: ctx["git_commit"],
          git_branch: ctx["git_branch"],
          working_directory: ctx["working_directory"],
          additional_metadata: (ctx["additional_metadata"] as Record<string, unknown>) ?? {},
          timestamp: new Date().toISOString(),
          visibility: "project",
        };
      }

      return {
        id: (data["id"] as string) ?? (data["memory_id"] as string) ?? null,
        type: typeStr,
        title: (data["title"] as string) ?? "",
        content: (data["content"] as string) ?? "",
        summary: (data["summary"] as string) ?? undefined,
        tags: (data["tags"] as string[]) ?? [],
        importance: (data["importance"] as number) ?? 0.5,
        confidence: (data["confidence"] as number) ?? 0.8,
        effectiveness: data["effectiveness"] as number | undefined,
        usage_count: (data["usage_count"] as number) ?? 0,
        created_at: createdAt,
        updated_at: updatedAt,
        last_accessed: undefined,
        version: 1,
        updated_by: undefined,
        relationships: undefined,
        match_info: undefined,
        context_summary: undefined,
        context,
      } as Memory;
    } catch (err) {
      console.error(`Failed to parse memory from API response: ${err}`);
      return null;
    }
  }
}

/** Deprecated alias -- use CloudRESTAdapter instead */
export const CloudBackend = CloudRESTAdapter;
