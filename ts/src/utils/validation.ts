/**
 * Input validation utilities for CLI commands.
 */

import { ValidationError } from "../errors.ts";

export const MAX_TITLE_LENGTH = 500;
export const MAX_CONTENT_LENGTH = 50_000;
export const MAX_SUMMARY_LENGTH = 1_000;
export const MAX_TAG_LENGTH = 100;
export const MAX_TAGS_COUNT = 50;
export const MAX_QUERY_LENGTH = 1_000;
export const MAX_CONTEXT_LENGTH = 10_000;

export function validateMemoryInput(args: Record<string, unknown>): void {
  if (args["title"] && typeof args["title"] === "string") {
    if (args["title"].length > MAX_TITLE_LENGTH) {
      throw new ValidationError(
        `Title exceeds ${MAX_TITLE_LENGTH} characters (got ${args["title"].length})`
      );
    }
  }

  if (args["content"] && typeof args["content"] === "string") {
    if (args["content"].length > MAX_CONTENT_LENGTH) {
      throw new ValidationError(
        `Content exceeds ${MAX_CONTENT_LENGTH} characters (got ${args["content"].length})`
      );
    }
  }

  if (args["summary"] && typeof args["summary"] === "string") {
    if (args["summary"].length > MAX_SUMMARY_LENGTH) {
      throw new ValidationError(`Summary exceeds ${MAX_SUMMARY_LENGTH} characters`);
    }
  }

  if (args["tags"] && Array.isArray(args["tags"])) {
    const tags = args["tags"] as string[];
    if (tags.length > MAX_TAGS_COUNT) {
      throw new ValidationError(`Too many tags (max ${MAX_TAGS_COUNT}, got ${tags.length})`);
    }
    for (const tag of tags) {
      if (typeof tag !== "string") {
        throw new ValidationError(`Tag must be string, got ${typeof tag}`);
      }
      if (tag.length > MAX_TAG_LENGTH) {
        throw new ValidationError(`Tag '${tag.slice(0, 20)}...' exceeds ${MAX_TAG_LENGTH} characters`);
      }
    }
  }
}

export function validateSearchInput(args: Record<string, unknown>): void {
  if (args["query"] && typeof args["query"] === "string") {
    if (args["query"].length > MAX_QUERY_LENGTH) {
      throw new ValidationError(`Query exceeds ${MAX_QUERY_LENGTH} characters`);
    }
  }
}

export function validateRelationshipInput(args: Record<string, unknown>): void {
  if (args["context"] && typeof args["context"] === "string") {
    if (args["context"].length > MAX_CONTEXT_LENGTH) {
      throw new ValidationError(`Context exceeds ${MAX_CONTEXT_LENGTH} characters`);
    }
  }
}
