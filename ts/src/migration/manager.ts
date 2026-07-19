/**
 * Migration manager for backend-to-backend memory migration.
 *
 * Performs migrations in 5 phases:
 * 1. Pre-flight validation (backends accessible, compatible)
 * 2. Export from source
 * 3. Validate export data
 * 4. Import to target (if not dry-run)
 * 5. Verify migration
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  type BackendConfig,
  type MigrationOptions,
  type MigrationResult,
  type ValidationResult,
  type VerificationResult,
  validateBackendConfig,
  MigrationError,
} from "./models.ts";
import { BackendFactory } from "../backends/factory.ts";
import { MemoryDatabase, CloudMemoryDatabase, type IMemoryDatabase } from "../database.ts";
import { exportToJson, importFromJson } from "../utils/export-import.ts";
import { getAllMemories, countMemories } from "../utils/pagination.ts";
import type { GraphBackend } from "../backends/index.ts";
import type { Memory } from "../models.ts";

export class MigrationManager {
  async migrate(
    sourceConfig: BackendConfig,
    targetConfig: BackendConfig,
    options: MigrationOptions
  ): Promise<MigrationResult> {
    const startTime = Date.now();
    console.log(
      `Starting migration: ${sourceConfig.backend_type} -> ${targetConfig.backend_type}`
    );

    const tempDir = mkdtempSync(join(tmpdir(), "memorygraph-migration-"));

    try {
      // Phase 1: Pre-flight validation
      console.log("Phase 1: Pre-flight validation");
      await this.validateSource(sourceConfig);
      await this.validateTarget(targetConfig);
      await this.checkCompatibility(sourceConfig, targetConfig);

      // Phase 2: Export from source
      console.log("Phase 2: Exporting from source");
      const tempExport = await this.exportFromSource(sourceConfig, options, tempDir);

      // Phase 3: Validate export
      console.log("Phase 3: Validating export");
      const validationResult = this.validateExport(tempExport);
      if (!validationResult.valid) {
        throw new MigrationError(`Export validation failed: ${validationResult.errors.join(", ")}`);
      }

      if (options.dry_run) {
        console.log("Dry-run mode: Skipping import phase");
        const sourceStats = await this.getBackendStats(sourceConfig);
        return {
          success: true,
          dry_run: true,
          source_stats: sourceStats,
          imported_memories: 0,
          imported_relationships: 0,
          skipped_memories: 0,
          duration_seconds: (Date.now() - startTime) / 1000,
          errors: [],
        };
      }

      // Phase 4: Import to target
      console.log("Phase 4: Importing to target");
      const importStats = await this.importToTarget(targetConfig, tempExport, options);

      // Phase 5: Verify migration
      let verificationResult: VerificationResult | undefined;
      if (options.verify) {
        console.log("Phase 5: Verifying migration");
        verificationResult = await this.verifyMigration(sourceConfig, targetConfig);

        if (!verificationResult.valid && options.rollback_on_failure) {
          console.error("Verification failed, rolling back...");
          // Read the export file to get the IDs that were imported,
          // so we only delete those memories (not pre-existing data)
          const exportedIds = this.readExportedMemoryIds(tempExport);
          await this.rollbackTarget(targetConfig, exportedIds);
          throw new MigrationError(
            `Verification failed: ${verificationResult.errors.join(", ")}`
          );
        }
      }

      const sourceStats = await this.getBackendStats(sourceConfig);
      const targetStats = await this.getBackendStats(targetConfig);

      console.log("Migration completed successfully");
      return {
        success: true,
        dry_run: false,
        source_stats: sourceStats,
        target_stats: targetStats,
        imported_memories: importStats["imported_memories"],
        imported_relationships: importStats["imported_relationships"],
        skipped_memories: importStats["skipped_memories"],
        verification_result: verificationResult,
        duration_seconds: (Date.now() - startTime) / 1000,
        errors: [],
      };
    } catch (err) {
      console.error(`Migration failed: ${err}`);
      return {
        success: false,
        dry_run: false,
        imported_memories: 0,
        imported_relationships: 0,
        skipped_memories: 0,
        duration_seconds: (Date.now() - startTime) / 1000,
        errors: [String(err)],
      };
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  private async validateSource(config: BackendConfig): Promise<void> {
    const errors = validateBackendConfig(config);
    if (errors.length > 0) {
      throw new MigrationError(`Invalid source configuration: ${errors.join(", ")}`);
    }

    const backend = await this.createBackend(config);
    try {
      const health = await backend.healthCheck();
      if (!health.connected) {
        throw new MigrationError(
          `Source backend not accessible: ${health["error"] ?? "unknown error"}`
        );
      }

      const stats = (health["statistics"] as Record<string, unknown>) ?? {};
      const memoryCount = (stats["memory_count"] as number) ?? 0;
      console.log(`Source backend healthy: ${memoryCount} memories`);

      if (memoryCount === 0) {
        console.warn("Source backend is empty");
      }
    } finally {
      await backend.disconnect();
    }
  }

  private async validateTarget(config: BackendConfig): Promise<void> {
    const errors = validateBackendConfig(config);
    if (errors.length > 0) {
      throw new MigrationError(`Invalid target configuration: ${errors.join(", ")}`);
    }

    const backend = await this.createBackend(config);
    try {
      const health = await backend.healthCheck();
      if (!health.connected) {
        throw new MigrationError(
          `Target backend not accessible: ${health["error"] ?? "unknown error"}`
        );
      }

      const stats = (health["statistics"] as Record<string, unknown>) ?? {};
      const memoryCount = (stats["memory_count"] as number) ?? 0;
      if (memoryCount > 0) {
        console.warn(
          `Target backend already contains ${memoryCount} memories. Migration will add to existing data.`
        );
      }
      console.log("Target backend accessible and writable");
    } finally {
      await backend.disconnect();
    }
  }

  private async checkCompatibility(
    sourceConfig: BackendConfig,
    targetConfig: BackendConfig
  ): Promise<void> {
    if (sourceConfig.backend_type === targetConfig.backend_type) {
      console.warn(
        `Source and target are the same backend type (${sourceConfig.backend_type})`
      );
    }
    console.log("Backend compatibility check passed");
  }

  private async exportFromSource(
    config: BackendConfig,
    _options: MigrationOptions,
    tempDir: string
  ): Promise<string> {
    const { db, close } = await this.createDb(config);
    try {
      const exportPath = join(
        tempDir,
        `migration_${new Date().toISOString().replace(/[:.]/g, "_")}.json`
      );
      await exportToJson(db, exportPath);
      console.log(`Export complete: ${exportPath}`);
      return exportPath;
    } catch (err) {
      throw new MigrationError(`Export failed: ${err}`);
    } finally {
      await close();
    }
  }

  private validateExport(exportPath: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      if (!existsSync(exportPath)) {
        errors.push(`Export file not found: ${exportPath}`);
        return { valid: false, errors, warnings };
      }

      const data = JSON.parse(readFileSync(exportPath, "utf-8"));

      if (!data["memories"]) errors.push("Export missing 'memories' field");
      if (!data["relationships"]) errors.push("Export missing 'relationships' field");
      if (!data["format_version"] && !data["export_version"]) {
        errors.push("Export missing version information");
      }

      const memoryCount = (data["memories"] as unknown[])?.length ?? 0;
      if (memoryCount === 0) {
        warnings.push("Export contains zero memories");
      } else {
        console.log(`Export contains ${memoryCount} memories`);
      }

      const relCount = (data["relationships"] as unknown[])?.length ?? 0;
      console.log(`Export contains ${relCount} relationships`);
    } catch (err) {
      errors.push(`Validation failed: ${err}`);
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  private async importToTarget(
    config: BackendConfig,
    exportPath: string,
    options: MigrationOptions
  ): Promise<Record<string, number>> {
    const { db, close } = await this.createDb(config);
    try {
      await db.initializeSchema();
      const result = await importFromJson(db, exportPath, options.skip_duplicates);
      console.log(
        `Import complete: ${result["imported_memories"]} memories, ${result["imported_relationships"]} relationships`
      );
      return result;
    } catch (err) {
      throw new MigrationError(`Import failed: ${err}`);
    } finally {
      await close();
    }
  }

  private async verifyMigration(
    sourceConfig: BackendConfig,
    targetConfig: BackendConfig
  ): Promise<VerificationResult> {
    const { db: sourceDb, close: closeSource } = await this.createDb(sourceConfig);
    const { db: targetDb, close: closeTarget } = await this.createDb(targetConfig);

    const errors: string[] = [];

    try {
      const sourceCount = await countMemories(sourceDb as any);
      const targetCount = await countMemories(targetDb as any);

      console.log(`Memory count - Source: ${sourceCount}, Target: ${targetCount}`);

      if (sourceCount !== targetCount) {
        errors.push(`Memory count mismatch: source=${sourceCount}, target=${targetCount}`);
      }

      // Sample check: verify up to 10 random memories
      const sampleSize = Math.min(10, sourceCount);
      let samplePassed = 0;

      if (sampleSize > 0) {
        const allMemories = await getAllMemories(sourceDb as any);
        const sample = allMemories.slice(0, sampleSize);

        for (const memory of sample) {
          if (!memory.id) continue;
          const targetMem = await targetDb.getMemory(memory.id, false);
          if (!targetMem) {
            errors.push(`Memory ${memory.id} not found in target`);
          } else if (targetMem.content !== memory.content) {
            errors.push(`Memory ${memory.id} content mismatch`);
          } else {
            samplePassed++;
          }
        }

        console.log(`Sample verification: ${samplePassed}/${sampleSize} passed`);
      }

      return {
        valid: errors.length === 0,
        errors,
        source_count: sourceCount,
        target_count: targetCount,
        sample_checks: sampleSize,
        sample_passed: samplePassed,
      };
    } catch (err) {
      errors.push(`Verification error: ${err}`);
      return {
        valid: false,
        errors,
        source_count: 0,
        target_count: 0,
        sample_checks: 0,
        sample_passed: 0,
      };
    } finally {
      await closeSource();
      await closeTarget();
    }
  }

  /** Read memory IDs from the export file so rollback can target only
   *  the memories that were imported, not pre-existing data. */
  private readExportedMemoryIds(exportPath: string): string[] {
    try {
      const data = JSON.parse(readFileSync(exportPath, "utf-8"));
      const memories = (data["memories"] as Array<Record<string, unknown>>) ?? [];
      return memories
        .map((m) => m["id"] as string)
        .filter((id): id is string => typeof id === "string");
    } catch {
      // If we can't read the file, return empty list (rollback will skip)
      console.warn("Could not read export file for targeted rollback");
      return [];
    }
  }

  private async rollbackTarget(
    config: BackendConfig,
    importedIds: string[] = []
  ): Promise<void> {
    if (importedIds.length > 0) {
      console.warn(`Rolling back target backend (deleting ${importedIds.length} imported memories)...`);
    } else {
      console.warn("Rolling back target backend (no IDs to delete, skipping)...");
    }
    const { db, close } = await this.createDb(config);
    try {
      for (const id of importedIds) {
        try {
          await db.deleteMemory(id);
        } catch {
          // Memory may not exist if import was partial
        }
      }
      console.log("Rollback complete");
    } catch (err) {
      throw new MigrationError(`Rollback failed: ${err}`);
    } finally {
      await close();
    }
  }

  private async createBackend(config: BackendConfig): Promise<GraphBackend> {
    try {
      switch (config.backend_type) {
        case "sqlite":
          return BackendFactory.createSQLite(config.path);
        case "falkordblite":
          return BackendFactory.createFalkorDBLite(config.path);
        case "cloud":
          return BackendFactory.createCloud(config.api_key, config.api_url);
        case "falkordb": {
          // Parse connection URI for host and port
          const m = config.uri?.match(/redis:\/\/(?:[^@]+@)?([^:]+):(\d+)/);
          return BackendFactory.createFalkorDB(
            m?.[1],
            m?.[2] ? parseInt(m[2], 10) : undefined,
            config.password
          );
        }
        default:
          throw new MigrationError(
            `Backend type ${config.backend_type} not yet supported for migration`
          );
      }
    } catch (err) {
      if (err instanceof MigrationError) throw err;
      throw new MigrationError(`Failed to create backend: ${err}`);
    }
  }

  private async createDb(
    config: BackendConfig
  ): Promise<{ db: IMemoryDatabase; close: () => Promise<void> }> {
    const backend = await this.createBackend(config);
    const isCloud = backend.backendName() === "cloud";
    const db = isCloud ? new CloudMemoryDatabase(backend) : new MemoryDatabase(backend);
    if (!isCloud) {
      await db.initializeSchema();
    }
    return {
      db,
      close: async () => {
        await db.close();
      },
    };
  }

  private async getBackendStats(config: BackendConfig): Promise<Record<string, unknown>> {
    const backend = await this.createBackend(config);
    try {
      const health = await backend.healthCheck();
      return (health["statistics"] as Record<string, unknown>) ?? {};
    } finally {
      await backend.disconnect();
    }
  }
}
