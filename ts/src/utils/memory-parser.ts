/**
 * Shared memory parsing utilities.
 *
 * Converts flat property dicts from graph DB backends into typed Memory objects.
 */

import {
  Memory,
  MemoryContext,
  MemoryType,
  isMemoryType,
  createMemory,
} from "../models.js";

/**
 * Convert database node properties to a Memory object.
 * Works with FalkorDB, Neo4j, SQLite, and other backends.
 */
export function parseMemoryFromProperties(
  nodeData: Record<string, unknown>,
  source = "unknown"
): Memory | null {
  try {
    // FalkorDB JS client returns nodes as { id, labels, properties: {...} }.
    // Unwrap so the flat property record is used directly. A `properties`
    // field that is null or an array is not a valid property record, so only
    // unwrap a plain (non-null, non-array) object.
    if (
      nodeData !== null &&
      typeof nodeData === "object" &&
      !Array.isArray(nodeData) &&
      "properties" in nodeData &&
      nodeData["properties"] !== null &&
      !Array.isArray(nodeData["properties"]) &&
      typeof nodeData["properties"] === "object"
    ) {
      nodeData = nodeData["properties"] as Record<string, unknown>;
    }

    const typeRaw = nodeData["type"] as string;
    const type = isMemoryType(typeRaw) ? typeRaw : MemoryType.GENERAL;

    const context = extractContext(nodeData);

    return createMemory({
      id: (nodeData["id"] as string) ?? null,
      type,
      title: (nodeData["title"] as string) ?? "",
      content: (nodeData["content"] as string) ?? "",
      summary: (nodeData["summary"] as string) ?? undefined,
      tags: (nodeData["tags"] as string[]) ?? [],
      importance: (nodeData["importance"] as number) ?? 0.5,
      confidence: (nodeData["confidence"] as number) ?? 0.8,
      effectiveness: (nodeData["effectiveness"] as number) ?? null,
      usage_count: (nodeData["usage_count"] as number) ?? 0,
      created_at: parseDateString(nodeData["created_at"]),
      updated_at: parseDateString(nodeData["updated_at"]),
      last_accessed: nodeData["last_accessed"]
        ? parseDateString(nodeData["last_accessed"])
        : undefined,
      context: context ?? undefined,
    });
  } catch (err) {
    console.error(`Failed to parse memory from ${source}: ${err}`);
    return null;
  }
}

function parseDateString(value: unknown): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function extractContext(nodeData: Record<string, unknown>): Partial<MemoryContext> | null {
  const contextData: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(nodeData)) {
    if (!key.startsWith("context_") || value === null || value === undefined) continue;
    const contextKey = key.slice(8); // remove "context_"

    // Deserialize JSON strings for known complex fields
    if (typeof value === "string") {
      if (
        contextKey === "additional_metadata" ||
        value.startsWith("[") ||
        value.startsWith("{")
      ) {
        try {
          contextData[contextKey] = JSON.parse(value);
        } catch {
          contextData[contextKey] = value;
        }
      } else {
        contextData[contextKey] = value;
      }
    } else {
      contextData[contextKey] = value;
    }
  }

  if (Object.keys(contextData).length === 0) return null;

  // Parse timestamp if present
  if (typeof contextData["timestamp"] === "string") {
    contextData["timestamp"] = new Date(contextData["timestamp"]).toISOString();
  }

  return contextData as Partial<MemoryContext>;
}
