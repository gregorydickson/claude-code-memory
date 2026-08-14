/**
 * Project-Aware Memory for Claude Code Integration.
 *
 * Port of the Python `memorygraph.integration.project_analysis` module.
 *
 * Provides project detection, codebase analysis, and file change tracking:
 * - Project detection from directory structure
 * - Codebase analysis (languages, frameworks, structure)
 * - File change tracking with git integration
 * - Code pattern identification
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { GraphBackend } from "../backends/index.js";
import {
  createMemory,
  createRelationshipProperties,
  MemoryType,
  SearchQuerySchema,
  type Memory,
} from "../models.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  project_id: string;
  name: string;
  path: string;
  project_type: string;
  git_remote?: string | null;
  description?: string | null;
  technologies: string[];
}

export interface CodebaseInfo {
  total_files: number;
  file_types: Record<string, number>;
  languages: string[];
  frameworks: string[];
  structure: Record<string, unknown>;
  config_files: string[];
}

export interface FileChange {
  file_path: string;
  change_type: string;
  timestamp: Date;
  lines_added: number;
  lines_removed: number;
}

export interface Pattern {
  pattern_id: string;
  pattern_type: string;
  description: string;
  examples: string[];
  frequency: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IGNORE_PATTERNS: string[] = [
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  "venv",
  ".venv",
  "env",
  ".env",
  "dist",
  "build",
  ".DS_Store",
  "thumbs.db",
];

const PROJECT_CONFIGS: Record<string, string[]> = {
  python: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "poetry.lock"],
  typescript: ["package.json", "tsconfig.json", "yarn.lock", "pnpm-lock.yaml"],
  javascript: ["package.json", "yarn.lock", "pnpm-lock.yaml"],
  rust: ["Cargo.toml", "Cargo.lock"],
  go: ["go.mod", "go.sum"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts"],
  ruby: ["Gemfile", "Gemfile.lock"],
  php: ["composer.json", "composer.lock"],
};

const FRAMEWORK_PATTERNS: Record<string, string[]> = {
  react: ["react", "@types/react"],
  vue: ["vue", "@vue/"],
  angular: ["@angular/"],
  next: ["next", "next.config"],
  fastapi: ["fastapi"],
  flask: ["flask"],
  django: ["django"],
  express: ["express"],
  nestjs: ["@nestjs/"],
  spring: ["spring-boot", "springframework"],
};

const EXT_TO_LANG: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".jsx": "javascript",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".kt": "kotlin",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMemory(
  type: string,
  title: string,
  content: string,
  metadata: Record<string, unknown>,
  id?: string
): Memory {
  return createMemory({
    id: id ?? randomUUID(),
    type,
    title,
    content,
    context: {
      additional_metadata: metadata,
    },
  });
}

function safeExecSync(cmd: string, opts: { cwd: string; timeout: number }): string | null {
  try {
    return execSync(cmd, { stdio: "pipe", ...opts }).toString().trim();
  } catch {
    return null;
  }
}

function safeGit(args: string[], opts: { cwd: string; timeout: number }): string | null {
  try {
    const result = spawnSync("git", args, { stdio: "pipe", ...opts });
    if (result.status !== 0 || !result.stdout) return null;
    return result.stdout.toString().trim();
  } catch {
    return null;
  }
}

/**
 * Collect the candidate directories to search for project config files. The
 * root directory is always included; shallow subdirectories (e.g. `ts/`,
 * `src/`, `server/`, `client/` under a monorepo root) are also probed so a
 * project whose tooling lives in a subproject is still detected.
 */
function collectConfigSearchDirs(dir: string): string[] {
  const dirs = [dir];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (IGNORE_PATTERNS.includes(entry.name)) continue;
      dirs.push(join(dir, entry.name));
    }
  } catch {
    // ignore unreadable directories
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect project from directory and return project information.
 */
export async function detectProject(
  backend: GraphBackend,
  directory: string
): Promise<ProjectInfo | null> {
  const dir = resolve(directory.replace(/^~/, process.env["HOME"] ?? "~"));

  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  // Extract project name from directory
  let projectName = basename(dir);

  // Check for git remote
  let gitRemote: string | null = null;
  const remoteResult = safeGit(
    ["config", "--get", "remote.origin.url"],
    { cwd: dir, timeout: 5000 }
  );
  if (remoteResult) {
    gitRemote = remoteResult;
    const match = /[/:]([^/]+?)(?:\.git)?$/.exec(gitRemote);
    if (match) projectName = match[1]!;
  }

  // Detect project type from config files
  let projectType = "unknown";
  const configFiles: string[] = [];
  const technologies: string[] = [];

  // Search the directory (and a few fixture/config subdirectories, e.g. a `ts/`
  // frontend under a monorepo root) for project config files.
  const configSearchDirs = collectConfigSearchDirs(dir);
  const foundConfigPaths = configSearchDirs
    .map((searchDir) =>
      Object.values(PROJECT_CONFIGS)
        .flatMap((configs) => configs)
        .map((config) => join(searchDir, config))
    )
    .flat()
    .filter((p) => existsSync(p) && statSync(p).isFile());

  const resolvedConfigMap = new Map<string, string>();
  for (const configPath of foundConfigPaths) {
    const config = basename(configPath);
    if (!resolvedConfigMap.has(config)) {
      resolvedConfigMap.set(config, configPath);
    }
  }

  for (const [lang, configs] of Object.entries(PROJECT_CONFIGS)) {
    for (const config of configs) {
      const configPath = resolvedConfigMap.get(config);
      if (!configPath) continue;
      configFiles.push(config);
      if (projectType === "unknown") projectType = lang;

      // Parse config file for more details
      if (config === "package.json") {
        try {
          const pkgData = JSON.parse(readFileSync(configPath, "utf-8"));
          const dependencies: Record<string, unknown> = {
            ...(pkgData["dependencies"] ?? {}),
            ...(pkgData["devDependencies"] ?? {}),
          };
          for (const [framework, patterns] of Object.entries(FRAMEWORK_PATTERNS)) {
            if (patterns.some((p) => Object.keys(dependencies).some((dep) => dep.includes(p)))) {
              technologies.push(framework);
            }
          }
        } catch {
          // ignore parse errors
        }
      } else if (config === "pyproject.toml") {
        try {
          const content = readFileSync(configPath, "utf-8");
          for (const [framework, patterns] of Object.entries(FRAMEWORK_PATTERNS)) {
            if (patterns.some((p) => content.includes(p))) {
              technologies.push(framework);
            }
          }
        } catch {
          // ignore read errors
        }
      }
    }
  }

  let detectedTypes = Object.entries(PROJECT_CONFIGS)
    .filter(([, configs]) => configs.some((c) => configFiles.includes(c)))
    .map(([lang]) => lang);

  // Special case: tsconfig.json means TypeScript
  if (configFiles.includes("tsconfig.json")) {
    projectType = "typescript";
    detectedTypes = ["typescript"];
  } else if (detectedTypes.length > 1) {
    projectType = "mixed";
    technologies.push(...detectedTypes);
  }

  const uniqueTechnologies = [...new Set(technologies)];

  const project: ProjectInfo = {
    project_id: randomUUID(),
    name: projectName,
    path: dir,
    project_type: projectType,
    git_remote: gitRemote,
    technologies: uniqueTechnologies,
  };

  // Check if project already exists in database
  let existing: Memory | null = null;
  try {
    const results = await backend.searchMemories(
      SearchQuerySchema.parse({
        memory_types: [MemoryType.PROJECT],
        limit: 100,
        include_relationships: false,
      })
    );
    existing =
      results.find(
        (m) =>
          m.title === projectName &&
          m.context?.additional_metadata?.["path"] === dir
      ) ?? null;
  } catch (err) {
    console.warn(`Failed to search for existing project:`, err);
  }

  if (existing) {
    project.project_id = existing.id!;
    try {
      await backend.executeQuery(
        `
        MATCH (p:Memory {id: $project_id})
        SET p.updated_at = $now
        RETURN p.id as id
        `,
        {
          project_id: project.project_id,
          git_remote: gitRemote,
          now: new Date().toISOString(),
          project_type: projectType,
          technologies: uniqueTechnologies,
        },
        true
      );
    } catch (err) {
      console.warn(`Failed to update existing project:`, err);
    }
  } else {
    const metadata: Record<string, unknown> = {
      name: projectName,
      path: dir,
      project_type: projectType,
      git_remote: gitRemote,
      technologies: uniqueTechnologies,
    };
    const memory = buildMemory(
      MemoryType.PROJECT,
      `Project: ${projectName}`,
      `Project: ${projectName}\nPath: ${dir}\nType: ${projectType}\nTechnologies: ${uniqueTechnologies.join(", ")}`,
      metadata,
      project.project_id
    );
    try {
      await backend.storeMemory(memory);
    } catch (err) {
      console.warn(`Failed to store new project:`, err);
    }
  }

  return project;
}

/**
 * Analyze codebase structure and characteristics.
 */
export async function analyzeCodebase(
  _backend: GraphBackend,
  directory: string
): Promise<CodebaseInfo> {
  const dir = resolve(directory.replace(/^~/, process.env["HOME"] ?? "~"));

  const fileTypes: Record<string, number> = {};
  const configFiles: string[] = [];
  let totalFiles = 0;

  // Walk directory tree
  walkDirectory(dir, (root, files) => {
    for (const file of files) {
      // Skip ignored patterns
      if (IGNORE_PATTERNS.some((p) => file === p || file.endsWith(p.replace(/\*/g, "")))) {
        continue;
      }
      totalFiles++;
      const ext = extname(file);
      if (ext) {
        fileTypes[ext] = (fileTypes[ext] ?? 0) + 1;
      }
      // Check if it's a config file
      for (const configs of Object.values(PROJECT_CONFIGS)) {
        if (configs.includes(file)) {
          configFiles.push(join(root, file));
        }
      }
    }
  });

  // Map extensions to languages
  const languages = [
    ...new Set(
      Object.keys(fileTypes)
        .filter((ext) => ext in EXT_TO_LANG)
        .map((ext) => EXT_TO_LANG[ext]!)
    ),
  ];

  return {
    total_files: totalFiles,
    file_types: fileTypes,
    languages,
    frameworks: [],
    structure: {},
    config_files: configFiles,
  };
}

/**
 * Recursively walk a directory, skipping ignored directories.
 */
function walkDirectory(
  root: string,
  callback: (root: string, files: string[]) => void
): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  const files: string[] = [];
  const subdirs: string[] = [];

  for (const entry of entries) {
    const name = entry.name;
    // Filter out ignored directories
    if (entry.isDirectory()) {
      if (IGNORE_PATTERNS.includes(name) || name.startsWith(".")) continue;
      subdirs.push(join(root, name));
    } else if (entry.isFile()) {
      files.push(name);
    }
  }

  callback(root, files);
  for (const sub of subdirs) {
    walkDirectory(sub, callback);
  }
}

/**
 * Track file changes using git diff.
 */
export async function trackFileChanges(
  backend: GraphBackend,
  repoPath: string,
  projectId: string
): Promise<FileChange[]> {
  const dir = resolve(repoPath.replace(/^~/, process.env["HOME"] ?? "~"));
  const changes: FileChange[] = [];

  const statusOutput = safeGit(["status", "--porcelain"], {
    cwd: dir,
    timeout: 10000,
  });
  if (!statusOutput) return changes;

  for (const line of statusOutput.split("\n")) {
    if (!line) continue;

    const status = line.slice(0, 2).trim();
    const filePath = line.slice(3).trim();

    // Map git status to change type
    let changeType = "modified";
    if (status === "A" || status === "??") {
      changeType = "added";
    } else if (status === "D") {
      changeType = "deleted";
    } else if (status === "M" || status === "MM") {
      changeType = "modified";
    }

    // Get diff stats for modified files
    let linesAdded = 0;
    let linesRemoved = 0;

    if (changeType === "modified" && existsSync(join(dir, filePath))) {
      const diffOutput = safeGit(
        ["diff", "--numstat", "HEAD", "--", filePath],
        { cwd: dir, timeout: 5000 }
      );
      if (diffOutput) {
        const parts = diffOutput.split("\t");
        if (parts.length >= 2) {
          linesAdded = /^\d+$/.test(parts[0]!) ? parseInt(parts[0]!, 10) : 0;
          linesRemoved = /^\d+$/.test(parts[1]!) ? parseInt(parts[1]!, 10) : 0;
        }
      }
    }

    const fileChange: FileChange = {
      file_path: filePath,
      change_type: changeType,
      timestamp: new Date(),
      lines_added: linesAdded,
      lines_removed: linesRemoved,
    };
    changes.push(fileChange);

    // Store file change as observation
    const metadata: Record<string, unknown> = {
      file_path: filePath,
      change_type: changeType,
      lines_added: linesAdded,
      lines_removed: linesRemoved,
      project_id: projectId,
    };
    const memory = buildMemory(
      MemoryType.FILE_CONTEXT,
      `File ${changeType}: ${filePath}`,
      `File: ${filePath}\nChange: ${changeType}\nLines added: ${linesAdded}\nLines removed: ${linesRemoved}`,
      metadata
    );

    let memoryId: string;
    try {
      memoryId = await backend.storeMemory(memory);
    } catch (err) {
      console.warn(`Failed to store file change memory for ${filePath}:`, err);
      continue;
    }

    // Link to project
    try {
      await backend.createRelationship(
        memoryId,
        projectId,
        "PART_OF",
        createRelationshipProperties({ strength: 1.0 })
      );
    } catch (err) {
      console.warn(`Failed to link file change to project:`, err);
    }

    // Create or get file entity and link
    const fileId = randomUUID();
    try {
      await backend.executeQuery(
        `
        MERGE (f:Entity {name: $file_path, type: 'file'})
        ON CREATE SET f.id = $file_id, f.created_at = $now
        RETURN f.id as id
        `,
        { file_path: filePath, file_id: fileId, now: new Date().toISOString() },
        true
      );
      await backend.createRelationship(
        memoryId,
        fileId,
        changeType === "modified" ? "MODIFIES" : "CREATES",
        createRelationshipProperties({ strength: 1.0 })
      );
    } catch (err) {
      console.warn(`Failed to link file change to file entity:`, err);
    }
  }

  return changes;
}

/**
 * Identify code patterns in files.
 */
export async function identifyCodePatterns(
  backend: GraphBackend,
  projectId: string,
  files: string[]
): Promise<Pattern[]> {
  const patterns: Pattern[] = [];

  // Common code patterns to identify
  const patternRegexes: Record<string, RegExp> = {
    api_endpoint: /@(?:app|router)\.(?:get|post|put|delete|patch)\(['"]([^'"]+)/g,
    class_definition: /class\s+(\w+)(?:\(.*?\))?:/g,
    function_definition: /(?:async\s+)?def\s+(\w+)\s*\(/g,
    import_statement: /(?:from\s+[\w.]+\s+)?import\s+([\w, ]+)/g,
    error_handling: /try:|except\s+(\w+(?:Error|Exception)):/g,
    async_await: /\basync\s+def\b|\bawait\b/g,
    type_annotation: /:\s*([A-Z][\w\[\], ]+)(?:\s*=)?/g,
  };

  const patternCounts: Record<string, number> = {};
  const patternExamples: Record<string, string[]> = {};

  for (const filePath of files) {
    if (!existsSync(filePath)) continue;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    for (const [patternType, regex] of Object.entries(patternRegexes)) {
      // Reset lastIndex for global regexes
      regex.lastIndex = 0;
      const matches = [...content.matchAll(regex)];
      if (matches.length > 0) {
        patternCounts[patternType] = (patternCounts[patternType] ?? 0) + matches.length;
        if (!(patternType in patternExamples)) patternExamples[patternType] = [];
        // Store first few examples
        for (const m of matches.slice(0, 3)) {
          patternExamples[patternType]!.push((m[0] ?? "").slice(0, 100));
        }
      }
    }
  }

  // Create pattern objects for significant patterns
  for (const [patternType, count] of Object.entries(patternCounts)) {
    if (count < 2) continue; // Only patterns that occur at least twice

    const confidence = Math.min(0.5 + count * 0.05, 0.95);
    const examples = (patternExamples[patternType] ?? []).slice(0, 5);

    const pattern: Pattern = {
      pattern_id: randomUUID(),
      pattern_type: patternType,
      description: `Code pattern: ${patternType}`,
      examples,
      frequency: count,
      confidence,
    };

    // Store pattern as memory
    const metadata: Record<string, unknown> = {
      pattern_type: patternType,
      frequency: count,
      confidence,
      project_id: projectId,
    };
    const memory = buildMemory(
      MemoryType.CODE_PATTERN,
      `Pattern: ${patternType}`,
      `Pattern Type: ${patternType}\nFrequency: ${count}\n\nExamples:\n` +
        examples.map((ex) => `- ${ex}`).join("\n"),
      metadata,
      pattern.pattern_id
    );

    let memoryId: string;
    try {
      memoryId = await backend.storeMemory(memory);
    } catch (err) {
      console.warn(`Failed to store code pattern ${patternType}:`, err);
      continue;
    }

    // Link to project
    try {
      await backend.createRelationship(
        memoryId,
        projectId,
        "FOUND_IN",
        createRelationshipProperties({ strength: confidence })
      );
    } catch (err) {
      console.warn(`Failed to link code pattern to project:`, err);
    }

    patterns.push(pattern);
  }

  return patterns;
}
