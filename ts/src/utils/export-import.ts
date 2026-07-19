/**
 * Export and import utilities for MemoryGraph data.
 * Supports JSON and Markdown export formats. Works with all backends.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";

import type { Memory, Relationship, SearchQuery, MemoryContext } from "../models.ts";
import {
  createMemory,
  createRelationshipProperties,
  MemoryType,
  isMemoryType,
  isRelationshipType,
  ALL_RELATIONSHIP_TYPES,
} from "../models.ts";
import { paginateMemories } from "./pagination.ts";
import type { IMemoryDatabase } from "../database.ts";

export async function exportToJson(
  db: IMemoryDatabase,
  outputPath: string
): Promise<Record<string, unknown>> {
  const allMemories = await getAllMemories(db);
  const relationshipsData = await exportRelationships(db, allMemories);

  const memoriesData = allMemories.map((memory) => {
    const memDict: Record<string, unknown> = {
      id: memory.id,
      type: memory.type,
      title: memory.title,
      content: memory.content,
      summary: memory.summary,
      tags: memory.tags,
      importance: memory.importance,
      confidence: memory.confidence,
      created_at: toIso(memory.created_at),
      updated_at: toIso(memory.updated_at),
    };
    if (memory.context) {
      const ctx: Record<string, unknown> = {};
      const ctxFields = [
        "project_path", "files_involved", "languages", "frameworks",
        "technologies", "additional_metadata",
      ];
      for (const field of ctxFields) {
        const value = (memory.context as Record<string, unknown>)[field];
        if (value !== null && value !== undefined) ctx[field] = value;
      }
      if (Object.keys(ctx).length > 0) memDict["context"] = ctx;
    }
    return memDict;
  });

  const backendType = (db as any).backend?.backendName?.() ?? "unknown";

  const exportData = {
    format_version: "2.0",
    export_version: "1.0",
    export_date: new Date().toISOString(),
    backend_type: backendType,
    memory_count: memoriesData.length,
    relationship_count: relationshipsData.length,
    memories: memoriesData,
    relationships: relationshipsData,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(exportData, null, 2));

  return {
    memory_count: memoriesData.length,
    relationship_count: relationshipsData.length,
    backend_type: backendType,
    output_path: outputPath,
  };
}

export async function importFromJson(
  db: IMemoryDatabase,
  inputPath: string,
  skipDuplicates = false
): Promise<Record<string, number>> {
  // Read with Node's fs/promises (replaces the former Bun-specific file API so
  // the library is portable across Node and Bun).
  const text = await readFile(inputPath, "utf-8");
  const data = JSON.parse(text);

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid export format: expected a JSON object");
  }
  if (!Array.isArray(data["memories"]) || !Array.isArray(data["relationships"])) {
    throw new Error("Invalid export format: 'memories' and 'relationships' must be arrays");
  }

  const formatVersion = data["format_version"] ?? data["export_version"];
  if (!formatVersion) {
    throw new Error("Invalid export format: missing version information");
  }

  const memories = data["memories"] as Record<string, unknown>[];
  const relationships = data["relationships"] as Record<string, unknown>[];

  // Validate memories
  for (const memData of memories) {
    for (const field of ["id", "type", "title", "content"]) {
      if (!(field in memData)) throw new Error(`Invalid memory data: missing field ${field}`);
    }
  }

  let importedMemories = 0;
  let skippedMemories = 0;

  for (const memData of memories) {
    try {
      if (skipDuplicates) {
        const existing = await db.getMemory(memData["id"] as string, false);
        if (existing) {
          skippedMemories++;
          continue;
        }
      }

      const type = memData["type"] as string;
      const memory = createMemory({
        id: memData["id"] as string,
        type: isMemoryType(type) ? type : MemoryType.GENERAL,
        title: memData["title"] as string,
        content: memData["content"] as string,
        summary: (memData["summary"] as string) ?? undefined,
        tags: (memData["tags"] as string[]) ?? [],
        importance: (memData["importance"] as number) ?? 0.5,
        confidence: (memData["confidence"] as number) ?? 0.8,
        context: memData["context"] as Partial<MemoryContext> | undefined,
      });

      await db.storeMemory(memory);
      importedMemories++;
    } catch (err) {
      console.error(`Failed to import memory ${memData["id"]}: ${err}`);
      skippedMemories++;
    }
  }

  let importedRelationships = 0;
  let skippedRelationships = 0;

  for (const relData of relationships) {
    try {
      // SEC-11: validate the relationship type against the RelationshipType
      // enum before calling the backend. This is a defense-in-depth check
      // that produces a clear, structured skip reason even when the backend
      // itself does not validate (e.g. Cypher backends that accept any
      // relationship type string at the Cypher layer). Backends that DO
      // validate (sqlite) would reject anyway; this ensures importFromJson
      // skips invalid types with a clear message regardless of backend.
      const relType = relData["type"] as string;
      if (typeof relType !== "string" || !isRelationshipType(relType)) {
        throw new Error(
          `Invalid relationship type: '${String(relType)}'. ` +
            `Valid types are: ${ALL_RELATIONSHIP_TYPES.join(", ")}`
        );
      }

      const fromMem = await db.getMemory(relData["from_memory_id"] as string, false);
      const toMem = await db.getMemory(relData["to_memory_id"] as string, false);
      if (!fromMem || !toMem) {
        skippedRelationships++;
        continue;
      }

      const propsData = (relData["properties"] as Record<string, unknown>) ?? {};
      await db.createRelationship(
        relData["from_memory_id"] as string,
        relData["to_memory_id"] as string,
        relType,
        createRelationshipProperties({
          strength: (propsData["strength"] as number) ?? 0.5,
          confidence: (propsData["confidence"] as number) ?? 0.8,
          context: (propsData["context"] as string) ?? undefined,
          evidence_count: (propsData["evidence_count"] as number) ?? 1,
        })
      );
      importedRelationships++;
    } catch (err) {
      console.error(`Failed to import relationship: ${err}`);
      skippedRelationships++;
    }
  }

  return {
    imported_memories: importedMemories,
    imported_relationships: importedRelationships,
    skipped_memories: skippedMemories,
    skipped_relationships: skippedRelationships,
  };
}

export async function exportToMarkdown(
  db: IMemoryDatabase,
  outputDir: string
): Promise<void> {
  const allMemories = await getAllMemories(db);
  await mkdir(outputDir, { recursive: true });

  for (const memory of allMemories) {
    const safeTitle = memory.title.replace(/[^a-zA-Z0-9 _-]/g, "_").replace(/ /g, "_");
    const safeId = (memory.id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 12);
    const filename = `${safeTitle}_${safeId}.md`;

    const related = await db.getRelatedMemories(memory.id!, { maxDepth: 1 });

    // YAML-escape string values to prevent frontmatter injection
    const yamlStr = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const yamlList = (items: string[]): string =>
      `[${items.map((i) => yamlStr(i)).join(", ")}]`;

    const lines: string[] = [
      "---",
      `title: ${yamlStr(memory.title)}`,
      `id: ${yamlStr(memory.id ?? "")}`,
      `type: ${memory.type}`,
      `importance: ${memory.importance}`,
      `confidence: ${memory.confidence}`,
      `tags: ${yamlList(memory.tags)}`,
      `created_at: ${yamlStr(toIso(memory.created_at))}`,
      `updated_at: ${yamlStr(toIso(memory.updated_at))}`,
    ];

    if (memory.context) {
      if (memory.context.project_path) lines.push(`project: ${yamlStr(memory.context.project_path)}`);
      if (memory.context.languages?.length) lines.push(`languages: ${yamlList(memory.context.languages)}`);
      if (memory.context.technologies?.length) lines.push(`technologies: ${yamlList(memory.context.technologies)}`);
    }

    lines.push("---", "");

    if (memory.summary) {
      lines.push("## Summary\n", memory.summary, "");
    }

    lines.push("## Content\n", memory.content, "");

    if (related.length > 0) {
      lines.push("## Relationships\n");
      for (const [relMem, rel] of related) {
        lines.push(`- **${rel.type}** -> [${relMem.title}](${relMem.id})`);
      }
      lines.push("");
    }

    await writeFile(join(outputDir, filename), lines.join("\n"));
  }

  console.log(`Exported ${allMemories.length} memories to ${outputDir}`);
}

async function getAllMemories(db: IMemoryDatabase): Promise<Memory[]> {
  const all: Memory[] = [];
  for await (const batch of paginateMemories(db as any, 1000)) {
    all.push(...batch);
  }
  return all;
}

async function exportRelationships(
  db: IMemoryDatabase,
  memories: Memory[]
): Promise<Record<string, unknown>[]> {
  const relMap = new Map<string, Record<string, unknown>>();

  for (const memory of memories) {
    if (!memory.id) continue;
    try {
      const related = await db.getRelatedMemories(memory.id, { maxDepth: 1 });
      for (const [, rel] of related) {
        const key = `${rel.from_memory_id}|${rel.to_memory_id}|${rel.type}`;
        if (!relMap.has(key)) {
          relMap.set(key, {
            from_memory_id: rel.from_memory_id,
            to_memory_id: rel.to_memory_id,
            type: rel.type,
            properties: {
              strength: rel.properties.strength,
              confidence: rel.properties.confidence,
              context: rel.properties.context,
              evidence_count: rel.properties.evidence_count,
            },
          });
        }
      }
    } catch (err) {
      console.warn(`Failed to export relationships for memory ${memory.id}: ${err}`);
    }
  }

  return Array.from(relMap.values());
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
