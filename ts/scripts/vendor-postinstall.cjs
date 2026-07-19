#!/usr/bin/env node
'use strict';

/**
 * MemoryGraph postinstall — copies VENDORED falkordblite binaries into the
 * `falkordblite` package's `bin/<platform>/` directory so end-user installs
 * work with NO network download.
 *
 * Tier 1 #5 (zero network at install) + #6 (no unvendored native dep in
 * spirit): the falkordb.so + redis-server for darwin-arm64 and linux-x64
 * are committed under `ts/vendor/falkordblite/<platform>/`. This script
 * copies them into `node_modules/falkordblite/bin/<platform>/` if they are
 * missing. It NEVER fetches from the network — if a vendored binary is
 * absent for the current platform, it logs a warning and exits 0.
 *
 * The default `falkordblite` backend (`backends/falkordblite.ts`) wires
 * `modulePath` + `redisServerPath` directly to the vendored tree at
 * runtime, so this copy step is belt-and-suspenders for users who import
 * the `falkordblite` package directly or bypass our backend wiring.
 */

const path = require('node:path');
const fs = require('node:fs');
const { platform, arch } = require('node:os');

const TS_DIR = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(TS_DIR, 'vendor', 'falkordblite');
const PKG_BIN_ROOT = path.join(TS_DIR, 'node_modules', 'falkordblite', 'bin');

/** Platforms we vendor binaries for. */
const VENDORED_PLATFORMS = ['darwin-arm64', 'linux-x64'];

function copyIfMissing(src, dest) {
  if (!fs.existsSync(src)) return false;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  } catch {
    // directory may already exist
  }
  if (fs.existsSync(dest)) {
    // Already present — leave it (idempotent).
    return true;
  }
  try {
    fs.copyFileSync(src, dest);
    // Ensure execute bit on the redis-server binary.
    if (path.basename(dest) === 'redis-server') {
      try {
        fs.chmodSync(dest, 0o755);
      } catch {
        // best-effort
      }
    }
    console.log(`  vendor-postinstall: copied ${path.relative(TS_DIR, src)} -> ${path.relative(TS_DIR, dest)}`);
    return true;
  } catch (err) {
    console.warn(`  vendor-postinstall: WARN failed to copy ${src} -> ${dest}: ${err.message}`);
    return false;
  }
}

function main() {
  console.log('memorygraph: vendor-postinstall — copying vendored falkordblite binaries (no network).');

  if (!fs.existsSync(VENDOR_ROOT)) {
    console.warn(`  vendor-postinstall: WARN vendor tree not found at ${VENDOR_ROOT}.`);
    console.warn('    The default falkordblite backend will fall back to the package own resolution.');
    return;
  }

  let copied = 0;
  let skipped = 0;
  let missing = 0;

  for (const plat of VENDORED_PLATFORMS) {
    const vendorDir = path.join(VENDOR_ROOT, plat);
    const pkgBinDir = path.join(PKG_BIN_ROOT, plat);
    for (const binName of ['falkordb.so', 'redis-server']) {
      const src = path.join(vendorDir, binName);
      const dest = path.join(pkgBinDir, binName);
      if (!fs.existsSync(src)) {
        missing += 1;
        continue;
      }
      if (fs.existsSync(dest)) {
        skipped += 1;
        continue;
      }
      if (copyIfMissing(src, dest)) {
        copied += 1;
      }
    }
  }

  // Also surface which platform the current install is running on so users
  // know which vendored binary the runtime will pick up.
  const currentPlat = (() => {
    const os = platform();
    const a = arch();
    if (os === 'darwin' && a === 'arm64') return 'darwin-arm64';
    if (os === 'linux' && a === 'x64') return 'linux-x64';
    return `${os}-${a}`;
  })();
  console.log(
    `  vendor-postinstall: done (copied=${copied}, skipped=${skipped}, missing=${missing}, current_platform=${currentPlat}).`
  );
}

try {
  main();
} catch (err) {
  // Never fail the install — the wired backend will fall back to package resolution.
  console.warn(`  vendor-postinstall: WARN ${err.message}`);
}
