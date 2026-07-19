/**
 * Relationship tool handlers for the CLI.
 *
 * create_relationship, get_related_memories
 */

import type { IMemoryDatabase } from "../database.js";
import { createRelationshipProperties, isRelationshipType } from "../models.js";
import { validateRelationshipInput } from "../utils/validation.js";
import { extractContextStructure } from "../utils/context-extractor.js";
import { handleToolErrors, neverThrowBoundary } from "./error-handling.js";

const _handleCreateRelationship = handleToolErrors(
  "create relationship",
  async (db: IMemoryDatabase, args: Record<string, unknown>): Promise<string> => {
    validateRelationshipInput(args);

    const relType = args["relationship_type"] as string;
    if (!isRelationshipType(relType)) {
      throw new Error(`Invalid relationship type: ${relType}`);
    }

    const userContext = (args["context"] as string) ?? undefined;
    let structuredContext: string | undefined;
    if (userContext) {
      const structure = extractContextStructure(userContext);
      structuredContext = JSON.stringify(structure);
    }

    const properties = createRelationshipProperties({
      strength: (args["strength"] as number) ?? 0.5,
      confidence: (args["confidence"] as number) ?? 0.8,
      context: structuredContext,
    });

    const relationshipId = await db.createRelationship(
      args["from_memory_id"] as string,
      args["to_memory_id"] as string,
      relType,
      properties
    );

    return `Relationship created successfully: ${relationshipId}`;
  }
);
export const handleCreateRelationship = neverThrowBoundary("create relationship", _handleCreateRelationship);

const _handleGetRelatedMemories = handleToolErrors(
  "get related memories",
  async (db: IMemoryDatabase, args: Record<string, unknown>): Promise<string> => {
    const memoryId = args["memory_id"] as string;
    const relationshipTypes = (args["relationship_types"] as string[]) ?? undefined;
    const maxDepth = (args["max_depth"] as number) ?? 2;

    const relatedMemories = await db.getRelatedMemories(memoryId, {
      relationshipTypes,
      maxDepth,
    });

    if (relatedMemories.length === 0) {
      return `No related memories found for: ${memoryId}`;
    }

    let text = `Found ${relatedMemories.length} related memories:\n\n`;
    for (let i = 0; i < relatedMemories.length; i++) {
      const [memory, relationship] = relatedMemories[i];
      text += `**${i + 1}. ${memory.title}** (ID: ${memory.id})\n`;
      text += `Relationship: ${relationship.type} (strength: ${relationship.properties.strength})\n`;
      text += `Type: ${memory.type} | Importance: ${memory.importance}\n\n`;
    }

    return text;
  }
);
export const handleGetRelatedMemories = neverThrowBoundary("get related memories", _handleGetRelatedMemories);
