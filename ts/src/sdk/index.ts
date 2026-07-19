/**
 * MemoryGraph SDK - TypeScript client library for the MemoryGraph Cloud API.
 *
 * Usage:
 *   import { MemoryGraphClient } from "./sdk/index.ts";
 *
 *   const client = new MemoryGraphClient({ apiKey: "mgraph_..." });
 *   const memory = await client.createMemory({
 *     type: "solution",
 *     title: "Fixed timeout issue",
 *     content: "Used exponential backoff with retries",
 *     tags: ["redis", "timeout"],
 *   });
 *
 * The SDK is framework-agnostic and can be used with any JS/TS AI agent or
 * LLM framework (LangChain.js, Vercel AI SDK, custom agents, etc.).
 */

// Client
export { MemoryGraphClient } from "./client.ts";
export type {
  MemoryGraphClientOptions,
  CreateMemoryParams,
  UpdateMemoryParams,
  SearchMemoriesParams,
  RecallMemoriesParams,
  CreateRelationshipParams,
  GetRelatedMemoriesParams,
} from "./client.ts";

// Models
export {
  MemoryType,
  RelationshipType,
  type Memory,
  type MemoryCreate,
  type MemoryUpdate,
  type Relationship,
  type RelationshipCreate,
  type SearchResult,
  type RelatedMemory,
} from "./models.ts";

// Exceptions
export {
  MemoryGraphError,
  AuthenticationError,
  RateLimitError,
  NotFoundError,
  ValidationError,
  ServerError,
} from "./exceptions.ts";

export const SDK_VERSION = "0.1.0";
