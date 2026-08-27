/**
 * Export and import utilities for MemoryGraph data.
 * Supports JSON and Markdown export formats. Works with all backends.
 */

import { mkdir, readFile, rename, unlink, open } from "node:fs/promises";
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
    // VAL-REVIEW-023: export the tracked-effectiveness fields so the
    // round trip preserves them (previously dropped here AND on import,
    // silently flattening every memory to defaults on restore/migrate).
    if (memory.effectiveness !== null && memory.effectiveness !== undefined)
      memDict["effectiveness"] = memory.effectiveness;
    if (memory.usage_count) memDict["usage_count"] = memory.usage_count;
    if (memory.last_accessed) memDict["last_accessed"] = toIso(memory.last_accessed);
    if (memory.version) memDict["version"] = memory.version;
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
  await atomicWriteFile(outputPath, JSON.stringify(exportData, null, 2));

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
        // VAL-REVIEW-023: restore the exported timestamps and tracked
        // fields instead of resetting them to import-time defaults.
        created_at: memData["created_at"] as string | undefined,
        updated_at: memData["updated_at"] as string | undefined,
        effectiveness: (memData["effectiveness"] as number | null) ?? null,
        usage_count: (memData["usage_count"] as number) ?? 0,
        last_accessed: (memData["last_accessed"] as string) ?? null,
        version: (memData["version"] as number) ?? 1,
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
      // VAL-REVIEW-023: restore the bi-temporal metadata so a restore or
      // migration keeps relationship history instead of stamping everything
      // with import-time timestamps. Only include keys actually present:
      // spreading `key: undefined` over createRelationshipProperties would
      // nullify its schema defaults (and trip NOT NULL constraints).
      const relProps: Record<string, unknown> = {
        strength: (propsData["strength"] as number) ?? 0.5,
        confidence: (propsData["confidence"] as number) ?? 0.8,
        evidence_count: (propsData["evidence_count"] as number) ?? 1,
      };
      if (typeof propsData["context"] === "string") relProps["context"] = propsData["context"];
      for (const key of [
        "success_rate",
        "created_at",
        "last_validated",
        "validation_count",
        "counter_evidence_count",
        "valid_from",
        "valid_until",
        "recorded_at",
        "invalidated_by",
      ]) {
        const value = propsData[key];
        if (value !== undefined && value !== null) relProps[key] = value;
      }
      await db.createRelationship(
        relData["from_memory_id"] as string,
        relData["to_memory_id"] as string,
        relType,
        createRelationshipProperties(relProps)
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

    await atomicWriteFile(join(outputDir, filename), lines.join("\n"));
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
      // VAL-REVIEW-018: lift the getRelatedMemories row cap for export; the
      // interactive default (20 on Cypher backends) silently truncated
      // memories with more relationships.
      const related = await db.getRelatedMemories(memory.id, { maxDepth: 1, limit: 10000 });
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
              // VAL-REVIEW-023: export the full property set so the round
              // trip preserves bi-temporal metadata and validation stats.
              success_rate: rel.properties.success_rate,
              created_at: rel.properties.created_at,
              last_validated: rel.properties.last_validated,
              validation_count: rel.properties.validation_count,
              counter_evidence_count: rel.properties.counter_evidence_count,
              valid_from: rel.properties.valid_from,
              valid_until: rel.properties.valid_until,
              recorded_at: rel.properties.recorded_at,
              invalidated_by: rel.properties.invalidated_by,
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

/**
 * Write `data` to `targetPath` atomically using a temp-file + fsync + rename
 * pattern, so a crash mid-export does not leave a half-written file at the
 * target path. The temp file is created in the SAME directory as the target
 * (so the final rename is atomic on POSIX — same filesystem). On failure at
 * any step the temp file is unlinked and the target is never touched. See
 * VAL-LOCAL-012.
 */
async function atomicWriteFile(targetPath: string, data: string): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(tempPath, "w", 0o644);
    await fh.writeFile(data);
    // fsync the file contents to disk so the renamed file is durable.
    await fh.sync();
    await fh.close();
    fh = null;
    // Atomic rename into place. On POSIX, rename is atomic when source and
    // destination are on the same filesystem (they are — same dir).
    await rename(tempPath, targetPath);
  } catch (err) {
    if (fh) {
      try { await fh.close(); } catch { /* ignore */ }
    }
    // Clean up the orphaned temp file if it still exists.
    try { await unlink(tempPath); } catch { /* ignore */ }
    throw err;
  }
}
