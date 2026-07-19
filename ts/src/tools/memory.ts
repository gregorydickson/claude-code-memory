/**
 * Memory CRUD tool handlers for the CLI.
 *
 * store_memory, get_memory, update_memory, delete_memory
 */

import type { IMemoryDatabase } from "../database.js";
import {
  Memory,
  MemoryType,
  isMemoryType,
  createMemory,
} from "../models.js";
import { MemoryContextSchema } from "../models.js";
import { validateMemoryInput, validateSearchInput } from "../utils/validation.js";
import { handleToolErrors, neverThrowBoundary } from "./error-handling.js";

const _handleStoreMemory = handleToolErrors(
  "store memory",
  async (db: IMemoryDatabase, args: Record<string, unknown>): Promise<string> => {
    validateMemoryInput(args);

    const type = args["type"] as string;
    if (!isMemoryType(type)) {
      throw new Error(`Invalid memory type: ${type}`);
    }

    let context: Record<string, unknown> | undefined;
    if (args["context"]) {
      const parsed = MemoryContextSchema.safeParse(args["context"]);
      if (parsed.success) {
        context = parsed.data;
      }
    }

    const memory = createMemory({
      type,
      title: args["title"] as string,
      content: args["content"] as string,
      summary: (args["summary"] as string) ?? undefined,
      tags: (args["tags"] as string[]) ?? [],
      importance: (args["importance"] as number) ?? 0.5,
      context,
    });

    const memoryId = await db.storeMemory(memory);
    return `Memory stored successfully with ID: ${memoryId}`;
  }
);
export const handleStoreMemory = neverThrowBoundary("store memory", _handleStoreMemory);

const _handleGetMemory = handleToolErrors(
  "get memory",
  async (db: IMemoryDatabase, args: Record<string, unknown>): Promise<string> => {
    const memoryId = args["memory_id"] as string;
    const includeRelationships = (args["include_relationships"] as boolean) ?? true;

    const memory = await db.getMemory(memoryId, includeRelationships);
    if (!memory) {
      return `Memory not found: ${memoryId}`;
    }

    let text = `**Memory: ${memory.title}**\n`;
    text += `Type: ${memory.type}\n`;
    text += `Created: ${memory.created_at}\n`;
    text += `Importance: ${memory.importance}\n`;
    text += `Tags: ${memory.tags.length > 0 ? memory.tags.join(", ") : "None"}\n\n`;
    text += `**Content:**\n${memory.content}`;

    if (memory.summary) {
      text = `**Summary:** ${memory.summary}\n\n` + text;
    }

    if (memory.context) {
      const parts: string[] = [];
      if (memory.context.project_path) parts.push(`Project: ${memory.context.project_path}`);
      if (memory.context.files_involved?.length) {
        const files = memory.context.files_involved.slice(0, 3).join(", ");
        const more = memory.context.files_involved.length > 3 ? ` (+${memory.context.files_involved.length - 3} more)` : "";
        parts.push(`Files: ${files}${more}`);
      }
      if (memory.context.languages?.length) parts.push(`Languages: ${memory.context.languages.join(", ")}`);
      if (memory.context.frameworks?.length) parts.push(`Frameworks: ${memory.context.frameworks.join(", ")}`);
      if (memory.context.technologies?.length) parts.push(`Technologies: ${memory.context.technologies.join(", ")}`);
      if (memory.context.git_branch) parts.push(`Branch: ${memory.context.git_branch}`);
      if (parts.length > 0) {
        text += "\n\n**Context:**\n" + parts.map((p) => `  ${p}`).join("\n");
      }
    }

    return text;
  }
);
export const handleGetMemory = neverThrowBoundary("get memory", _handleGetMemory);

const _handleUpdateMemory = handleToolErrors(
  "update memory",
  async (db: IMemoryDatabase, args: Record<string, unknown>): Promise<string> => {
    validateMemoryInput(args);
    const memoryId = args["memory_id"] as string;

    const memory = await db.getMemory(memoryId, false);
    if (!memory) {
      return `Memory not found: ${memoryId}`;
    }

    if (args["title"]) memory.title = args["title"] as string;
    if (args["content"]) memory.content = args["content"] as string;
    if (args["summary"] !== undefined) memory.summary = args["summary"] as string;
    if (args["tags"]) memory.tags = args["tags"] as string[];
    if (args["importance"] !== undefined) memory.importance = args["importance"] as number;

    const success = await db.updateMemory(memory);
    return success
      ? `Memory updated successfully: ${memoryId}`
      : `Failed to update memory: ${memoryId}`;
  }
);
export const handleUpdateMemory = neverThrowBoundary("update memory", _handleUpdateMemory);

const _handleDeleteMemory = handleToolErrors(
  "delete memory",
  async (db: IMemoryDatabase, args: Record<string, unknown>): Promise<string> => {
    const memoryId = args["memory_id"] as string;
    const success = await db.deleteMemory(memoryId);
    return success
      ? `Memory deleted successfully: ${memoryId}`
      : `Failed to delete memory (may not exist): ${memoryId}`;
  }
);
export const handleDeleteMemory = neverThrowBoundary("delete memory", _handleDeleteMemory);
