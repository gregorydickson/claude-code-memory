/**
 * FalkorDBLite backend implementation.
 *
 * FalkorDBLite is an embedded graph database with native Cypher support.
 * In the TypeScript/Bun port, we connect to a local FalkorDB instance
 * via the Redis protocol (FalkorDB runs on top of Redis).
 *
 * For truly embedded (zero-server) operation, a SQLite-based fallback
 * is available via the SQLite backend.
 *
 * Offline / vendored binaries (Tier 1 #5 / #6):
 * ---------------------------------------------
 * The native `falkordb.so` module and a compatible `redis-server` are
 * VENDORED into the repo under `ts/vendor/falkordblite/<platform>/`. At
 * `connect()` time we resolve the vendored paths for the current platform
 * and pass them explicitly to `FalkorDB.open({ modulePath, redisServerPath })`
 * so the falkordblite package's `BinaryManager` never attempts a network
 * acquisition. If the vendored binary is absent for the current platform
 * (e.g. linux-arm64, win32), we fall through to the package's own
 * resolution so we do not break unsupported platforms — they simply keep
 * using whatever resolution the package already does.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";
import { platform, arch } from "node:os";

import { Config } from "../config.ts";
import { DatabaseConnectionError } from "../errors.ts";
import { BaseFalkorDBBackend } from "./falkordb-shared.ts";
import type { HealthCheckResult } from "./index.ts";

/**
 * ESM-safe `__dirname` equivalent. Under Bun, `__dirname` is a global; under
 * Node ESM (the M3+ runtime target), it is undefined. `import.meta.url` is
 * available in both runtimes, so `dirname(fileURLToPath(import.meta.url))`
 * resolves to this file's directory (`ts/src/backends/`) in both. This is
 * required for VAL-CROSS-001 / VAL-CROSS-003 (node parity) so the vendored-
 * binary resolver works under `node`, not just under `bun`.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Map the current Node process to a vendored platform directory name.
 * Returns `undefined` for platforms we do not vendor (so the caller can
 * fall back to the falkordblite package's own binary resolution).
 */
function vendoredPlatformDir(): string | undefined {
  const os = platform();
  const a = arch();
  // Only the two platforms we vendor binaries for. Others fall through.
  if (os === "darwin" && a === "arm64") return "darwin-arm64";
  if (os === "linux" && a === "x64") return "linux-x64";
  return undefined;
}

/**
 * Resolve the vendored `falkordb.so` + `redis-server` paths for the current
 * platform. Returns `{ modulePath, redisServerPath }` when BOTH vendored
 * binaries are present, otherwise `undefined` (caller falls back to the
 * package's own resolution).
 *
 * The vendor tree lives at `ts/vendor/falkordblite/<platform>/`. We resolve
 * it relative to this source file (`ts/src/backends/falkordblite.ts`).
 */
function resolveVendoredBinaries(): { modulePath: string; redisServerPath: string } | undefined {
  const plat = vendoredPlatformDir();
  if (!plat) return undefined;
  // this file: ts/src/backends/falkordblite.ts
  // vendor:    ts/vendor/falkordblite/<platform>/
  const vendorDir = join(__dirname, "..", "..", "vendor", "falkordblite", plat);
  const modulePath = join(vendorDir, "falkordb.so");
  const redisServerPath = join(vendorDir, "redis-server");
  if (existsSync(modulePath) && existsSync(redisServerPath)) {
    return { modulePath, redisServerPath };
  }
  return undefined;
}

export class FalkorDBLiteBackend extends BaseFalkorDBBackend {
  _display_name = "FalkorDBLite";

  dbPath: string;
  // Exposed for diagnostics / health output: which binaries were wired.
  private _vendoredBinaries?: { modulePath: string; redisServerPath: string };

  constructor(dbPath?: string, graphName = "memorygraph") {
    super(graphName);
    this.dbPath = dbPath ?? Config.FALKORDBLITE_PATH;
    // Ensure directory exists
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    } catch {
      // Directory may already exist
    }
  }

  async connect(): Promise<boolean> {
    try {
      // Use falkordblite for embedded, zero-server operation
      let FalkorDB: any;
      try {
        const mod = await import("falkordblite");
        FalkorDB = mod.FalkorDB ?? mod.default;
      } catch {
        throw new DatabaseConnectionError(
          "falkordblite package is required for FalkorDBLite backend. " +
            "Install with: bun add falkordblite\n" +
            "Alternatively, use --backend sqlite for zero-server embedded storage."
        );
      }

      // FalkorDBLite opens an embedded redis-server with the FalkorDB module.
      // Tier 1 #5/#6: pass the VENDORED modulePath + redisServerPath so the
      // falkordblite package's BinaryManager never attempts a network
      // acquisition. If the vendored binaries are not present for the current
      // platform, fall through to the package's own resolution (unchanged
      // behavior for unvendored platforms).
      const openOpts: Record<string, unknown> = { path: this.dbPath };
      const vendored = resolveVendoredBinaries();
      if (vendored) {
        openOpts.modulePath = vendored.modulePath;
        openOpts.redisServerPath = vendored.redisServerPath;
        this._vendoredBinaries = vendored;
      }

      this.client = await FalkorDB.open(openOpts);

      this.graph = this.client.selectGraph(this.graphName);
      this._connected = true;

      if (this._vendoredBinaries) {
        console.log(
          `Successfully connected to FalkorDBLite at ${this.dbPath} ` +
            `(vendored module: ${this._vendoredBinaries.modulePath}, ` +
            `vendored redis-server: ${this._vendoredBinaries.redisServerPath})`
        );
      } else {
        console.log(`Successfully connected to FalkorDBLite at ${this.dbPath}`);
      }
      return true;
    } catch (err) {
      if (err instanceof DatabaseConnectionError) throw err;
      console.error(`Failed to connect to FalkorDBLite: ${err}`);
      throw new DatabaseConnectionError(
        `Failed to connect to FalkorDBLite: ${err}\n` +
          "Alternatively, use --backend sqlite for zero-server embedded storage."
      );
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const healthInfo: HealthCheckResult = {
      connected: this._connected,
      backend_type: "falkordblite",
      db_path: this.dbPath,
      graph_name: this.graphName,
    };

    // Surface which binaries are wired so `health` / `config` can prove the
    // vendored path is in use (VAL-CROSS-008).
    if (this._vendoredBinaries) {
      healthInfo["vendored_module_path"] = this._vendoredBinaries.modulePath;
      healthInfo["vendored_redis_server_path"] = this._vendoredBinaries.redisServerPath;
    }

    if (this._connected) {
      try {
        const countResult = await this.executeQuery(
          "MATCH (m:Memory) RETURN count(m) as count",
          {},
          false
        );
        if (countResult.length > 0) {
          healthInfo["statistics"] = {
            memory_count: countResult[0]["count"],
          };
        }
      } catch (err) {
        healthInfo["warning"] = String(err);
      }
    }

    return healthInfo;
  }

  backendName(): string {
    return "falkordblite";
  }

  static async create(
    dbPath?: string,
    graphName = "memorygraph"
  ): Promise<FalkorDBLiteBackend> {
    const backend = new FalkorDBLiteBackend(dbPath, graphName);
    await backend.connect();
    return backend;
  }
}
