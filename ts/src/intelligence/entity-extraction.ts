/**
 * Entity Extraction - Automatic entity identification and linking.
 *
 * Port of the Python `memorygraph.intelligence.entity_extraction` module.
 * Extracts entities from memory content using regex patterns. The Python
 * version supports optional spaCy NLP extraction; spaCy is not available in
 * JS so NLP extraction is stubbed out and only regex-based extraction is
 * performed.
 */

import { z } from "zod";

import type { GraphBackend } from "../backends/index.js";

// ---------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------

export const EntityType = {
  FILE: "file",
  FUNCTION: "function",
  CLASS: "class",
  ERROR: "error",
  TECHNOLOGY: "technology",
  CONCEPT: "concept",
  PERSON: "person",
  PROJECT: "project",
  COMMAND: "command",
  PACKAGE: "package",
  URL: "url",
  VARIABLE: "variable",
} as const;

export type EntityType = (typeof EntityType)[keyof typeof EntityType];

export const ALL_ENTITY_TYPES: string[] = Object.values(EntityType);

export function isEntityType(value: string): value is EntityType {
  return ALL_ENTITY_TYPES.includes(value);
}

// ---------------------------------------------------------------------------
// Entity schema / interface
// ---------------------------------------------------------------------------

export const EntitySchema = z.object({
  text: z.string().min(1),
  entity_type: z.enum(ALL_ENTITY_TYPES as [string, ...string[]]),
  confidence: z.number().min(0).max(1).default(1.0),
  context: z.string().nullish(),
  start_pos: z.number().int().nullish(),
  end_pos: z.number().int().nullish(),
});

export type Entity = z.infer<typeof EntitySchema>;

// ---------------------------------------------------------------------------
// Entity extractor
// ---------------------------------------------------------------------------

interface PatternSpec {
  /** Regex source. Flags are applied separately so we can capture groups. */
  source: string;
  flags: string;
  /**
   * Index of the capture group to use as the entity text. 0 means the entire
   * match (no capture group).
   */
  group: number;
}

const PATTERNS: Record<EntityType, PatternSpec[]> = {
  [EntityType.FILE]: [
    { source: "(?:/[\\w\\-./]+)", flags: "g", group: 0 },
    { source: "(?:[\\w\\-./]+\\.[\\w]+)", flags: "g", group: 0 },
    { source: "(?:[A-Z]:\\\\[\\w\\-\\\\./]+)", flags: "g", group: 0 },
  ],
  [EntityType.FUNCTION]: [
    { source: "\\b([a-z_]\\w*)\\(\\)", flags: "gi", group: 1 },
    { source: "\\b([a-z]\\w*[A-Z]\\w*)\\(\\)", flags: "g", group: 1 },
  ],
  [EntityType.CLASS]: [
    {
      source:
        "\\b([A-Z][\\w]*(?:Class|Handler|Service|Manager|Controller|Provider|Factory|Builder|Strategy|Adapter|Facade|Proxy|Decorator|Observer|Singleton|Component|Module|Store|Action|Reducer|Hook|Context))\\b",
      flags: "g",
      group: 1,
    },
    { source: "\\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\\b", flags: "g", group: 1 },
  ],
  [EntityType.ERROR]: [
    { source: "\\b(\\w*(?:Error|Exception))\\b", flags: "g", group: 1 },
    { source: "\\b([45]\\d{2})\\b", flags: "g", group: 1 },
    { source: "\\b(E(?:RR)?_[\\w_]+)\\b", flags: "g", group: 1 },
  ],
  [EntityType.TECHNOLOGY]: [
    {
      source:
        "\\b(Python|JavaScript|TypeScript|Java|Kotlin|Swift|Go|Rust|C\\+\\+|C#|Ruby|PHP|Scala|Haskell|Elixir|Clojure|Erlang)\\b",
      flags: "g",
      group: 1,
    },
    {
      source:
        "\\b(React|Vue|Angular|Django|Flask|FastAPI|Express|Spring|Rails|Laravel|Symfony|Nest\\.?js|Next\\.?js|Nuxt\\.?js|Svelte|Solid)\\b",
      flags: "g",
      group: 1,
    },
    {
      source:
        "\\b(PostgreSQL|MySQL|MongoDB|Redis|Neo4j|Memgraph|SQLite|DynamoDB|Cassandra|CouchDB|Elasticsearch|MariaDB|Oracle|MSSQL)\\b",
      flags: "g",
      group: 1,
    },
    {
      source:
        "\\b(AWS|Azure|GCP|Docker|Kubernetes|Terraform|Ansible|Jenkins|GitHub|GitLab|CircleCI|Travis)\\b",
      flags: "g",
      group: 1,
    },
  ],
  [EntityType.CONCEPT]: [
    {
      source:
        "\\b(authentication|authorization|caching|logging|testing|debugging|deployment|migration|refactoring|optimization|validation|serialization|deserialization|encryption|decryption|compression|decompression)\\b",
      flags: "g",
      group: 1,
    },
    {
      source:
        "\\b(MVC|MVVM|MVP|REST|GraphQL|gRPC|microservices|monolith|serverless|event-driven|CQRS|DDD|hexagonal|clean architecture)\\b",
      flags: "gi",
      group: 1,
    },
    {
      source: "\\b(CORS|XSS|CSRF|SQL injection|JWT|OAuth|SAML|TLS|SSL|HTTPS|firewall|WAF)\\b",
      flags: "g",
      group: 1,
    },
  ],
  [EntityType.COMMAND]: [
    { source: "`([^`]+)`", flags: "g", group: 1 },
    { source: '"([^"]+)"\\s*(?:command|cmd|run|exec)', flags: "gi", group: 1 },
  ],
  [EntityType.PACKAGE]: [
    {
      source: "\\b((?:@[\\w\\-]+\\/)?[\\w\\-]+)\\b(?=\\s*(?:package|library|module|dependency))",
      flags: "g",
      group: 1,
    },
    {
      source:
        "\\b(react-\\w+|vue-\\w+|@types/\\w+|webpack-\\w+|babel-\\w+|eslint-\\w+|pytest-\\w+)\\b",
      flags: "g",
      group: 1,
    },
  ],
  [EntityType.URL]: [
    {
      source: "https?://[\\w\\-./]+(?:\\?[\\w\\-=&]*)?",
      flags: "g",
      group: 0,
    },
  ],
  [EntityType.VARIABLE]: [
    { source: "\\b([A-Z][A-Z0-9_]{2,})\\b", flags: "g", group: 1 },
    { source: "\\b([a-z_]\\w*[a-z]\\w*)\\b(?=\\s*[:=])", flags: "g", group: 1 },
  ],
  [EntityType.PERSON]: [
    { source: "@([\\w\\-]+)", flags: "g", group: 1 },
  ],
  [EntityType.PROJECT]: [
    {
      source: "\\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*)\\b(?=\\s*(?:project|repo|repository))",
      flags: "g",
      group: 1,
    },
  ],
};

export class EntityExtractor {
  /** Enable NLP-based extraction. Stubbed - no JS spaCy equivalent. */
  enableNlp: boolean;

  constructor(enableNlp = false) {
    this.enableNlp = enableNlp;
  }

  /**
   * Extract entities from text.
   *
   * @param text - Text to extract entities from
   * @param minConfidence - Minimum confidence threshold (0.0-1.0)
   * @returns List of extracted entities
   */
  extract(text: string, minConfidence = 0.5): Entity[] {
    let entities: Entity[] = [];

    entities = entities.concat(this.extractWithRegex(text));

    // NLP extraction is stubbed out - no JS equivalent of spaCy available.
    if (this.enableNlp) {
      // Intentionally a no-op; logging kept for parity with Python version.
      console.warn(
        "NLP-based entity extraction is not available in the TypeScript port; using regex-only extraction."
      );
    }

    entities = this.deduplicate(entities);
    entities = entities.filter((e) => e.confidence >= minConfidence);

    return entities;
  }

  private extractWithRegex(text: string): Entity[] {
    const entities: Entity[] = [];

    for (const [entityTypeStr, patterns] of Object.entries(PATTERNS)) {
      const entityType = entityTypeStr as EntityType;
      for (const spec of patterns) {
        const re = new RegExp(spec.source, spec.flags);
        let match: RegExpExecArray | null;
        // Reset lastIndex in case the regex is stateful (it isn't here, but be safe).
        re.lastIndex = 0;
        while ((match = re.exec(text)) !== null) {
          const entityText = match[spec.group] ?? match[0];

          if (entityText.length < 2 || entityText.length > 100) {
            // Avoid infinite loops on zero-length matches.
            if (match.index === re.lastIndex) re.lastIndex++;
            continue;
          }

          const confidence = this.calculateConfidence(entityType, entityText);

          const start = Math.max(0, match.index - 50);
          const end = Math.min(text.length, match.index + entityText.length + 50);
          const context = text.slice(start, end);

          entities.push({
            text: entityText,
            entity_type: entityType,
            confidence,
            context,
            start_pos: match.index,
            end_pos: match.index + entityText.length,
          });

          // Guard against zero-length matches causing infinite loops.
          if (match.index === re.lastIndex) re.lastIndex++;
        }
      }
    }

    return entities;
  }

  private calculateConfidence(entityType: EntityType, text: string): number {
    let confidence = 0.7;

    if (entityType === EntityType.FILE) {
      if (
        text.endsWith(".py") ||
        text.endsWith(".js") ||
        text.endsWith(".ts") ||
        text.endsWith(".jsx") ||
        text.endsWith(".tsx") ||
        text.endsWith(".md") ||
        text.endsWith(".txt") ||
        text.endsWith(".json") ||
        text.endsWith(".yaml") ||
        text.endsWith(".yml")
      ) {
        confidence = 0.95;
      } else if (text.includes("/") || text.includes("\\")) {
        confidence = 0.85;
      }
    } else if (entityType === EntityType.FUNCTION) {
      if (text.endsWith("()")) confidence = 0.9;
    } else if (entityType === EntityType.CLASS) {
      if (
        text.endsWith("Handler") ||
        text.endsWith("Service") ||
        text.endsWith("Manager") ||
        text.endsWith("Controller")
      ) {
        confidence = 0.95;
      } else {
        confidence = 0.75;
      }
    } else if (entityType === EntityType.ERROR) {
      if (text.endsWith("Error") || text.endsWith("Exception")) {
        confidence = 0.95;
      } else if (/^[45]\d{2}$/.test(text)) {
        confidence = 0.9;
      }
    } else if (entityType === EntityType.TECHNOLOGY) {
      confidence = 0.95;
    } else if (entityType === EntityType.URL) {
      confidence = 0.99;
    } else if (entityType === EntityType.COMMAND) {
      confidence = 0.9;
    }

    return Math.min(confidence, 1.0);
  }

  private deduplicate(entities: Entity[]): Entity[] {
    const seen = new Map<string, Entity>();

    for (const entity of entities) {
      const key = `${entity.text.toLowerCase()}:${entity.entity_type}`;
      const existing = seen.get(key);
      if (!existing || entity.confidence > existing.confidence) {
        seen.set(key, entity);
      }
    }

    return Array.from(seen.values());
  }
}

// ---------------------------------------------------------------------------
// Singleton convenience
// ---------------------------------------------------------------------------

const defaultExtractor = new EntityExtractor();

export function extractEntities(text: string, minConfidence = 0.5): Entity[] {
  return defaultExtractor.extract(text, minConfidence);
}

// ---------------------------------------------------------------------------
// Entity linking
// ---------------------------------------------------------------------------

/**
 * Link extracted entities to a memory by creating entity nodes and MENTIONS
 * relationships.
 *
 * @param backend - Graph database backend instance
 * @param memoryId - ID of the memory to link entities to
 * @param entities - List of entities to link
 * @returns List of created entity IDs
 */
export async function linkEntities(
  backend: GraphBackend,
  memoryId: string,
  entities: Entity[]
): Promise<string[]> {
  const entityIds: string[] = [];

  for (const entity of entities) {
    const query = `
      MERGE (e:Entity {text: $text, type: $type})
      ON CREATE SET
        e.id = randomUUID(),
        e.created_at = $now,
        e.occurrence_count = 1
      ON MATCH SET
        e.occurrence_count = e.occurrence_count + 1,
        e.last_seen = $now
      WITH e
      MATCH (m:Memory {id: $memory_id})
      MERGE (m)-[r:MENTIONS]->(e)
      ON CREATE SET
        r.confidence = $confidence,
        r.created_at = $now
      RETURN e.id as entity_id
    `;

    const params = {
      text: entity.text,
      type: entity.entity_type,
      memory_id: memoryId,
      confidence: entity.confidence,
      now: new Date().toISOString(),
    };

    try {
      const result = await backend.executeQuery(query, params, true);
      if (result && result.length > 0) {
        const entityId = result[0]["entity_id"];
        if (typeof entityId === "string") {
          entityIds.push(entityId);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Failed to link entity '${entity.text}': ${message}`);
      continue;
    }
  }

  return entityIds;
}
