/**
 * Project context detection utilities.
 * Auto-detects project name and context from the current working directory or git repo.
 */

import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";

export interface ProjectContext {
  project_name: string;
  project_path: string;
  is_git_repo: boolean;
  git_remote?: string;
}

export function detectProjectContext(cwd?: string): ProjectContext | null {
  const workingDir = resolve(cwd ?? process.cwd());

  const gitInfo = detectFromGit(workingDir);
  if (gitInfo) {
    return gitInfo;
  }

  return {
    project_name: basename(workingDir),
    project_path: workingDir,
    is_git_repo: false,
  };
}

/**
 * Run a git subcommand using the array form of spawnSync (no shell, not
 * injectable). Returns stdout trimmed, or `null` on non-zero exit / error.
 *
 * Tier 0 #2 security hygiene: every git invocation under ts/src/ MUST go
 * through this array form — see tests/security/shell-string-git-regression.test.ts.
 */
function safeGit(args: string[], cwd: string, timeout = 2000): string | null {
  try {
    const result = spawnSync("git", args, {
      cwd,
      stdio: "pipe",
      timeout,
    });
    if (result.status !== 0 || !result.stdout) return null;
    return result.stdout.toString().trim();
  } catch {
    return null;
  }
}

function detectFromGit(cwd: string): ProjectContext | null {
  // Probe: are we inside a git work tree? (exit 0 ⇒ yes.)
  const probe = safeGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (probe === null) return null;

  const repoRoot = safeGit(["rev-parse", "--show-toplevel"], cwd);
  if (!repoRoot) return null;

  const projectPath = repoRoot;
  const projectName = basename(projectPath);

  // git remote is optional; a missing `origin` is fine.
  const rawRemote = safeGit(["remote", "get-url", "origin"], cwd);
  let gitRemote: string | undefined;
  if (rawRemote) {
    // Strip embedded credentials from git remote URL.
    gitRemote = rawRemote.replace(/^(https?:\/\/)[^@]+@/, "$1");
  }

  return {
    project_name: projectName,
    project_path: projectPath,
    is_git_repo: true,
    git_remote: gitRemote,
  };
}

export async function getProjectFromMemories(
  _db: unknown,
  _limit = 50
): Promise<string | null> {
  return null;
}
