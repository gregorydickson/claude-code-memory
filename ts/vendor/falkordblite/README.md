# Vendored falkordblite binaries

This directory holds the native binaries the default `falkordblite` backend
needs, vendored into the repo so end-user installs require **zero network**
(Tier 1 #5) and ship **no unvendored native dependency** (Tier 1 #6).

Layout:

```
ts/vendor/falkordblite/
  darwin-arm64/
    falkordb.so        # FalkorDB module v4.16.3 (Mach-O arm64, ~24 MB)
    redis-server       # Homebrew Redis 8.8.0 (Mach-O arm64, ~2.2 MB)
  linux-x64/
    falkordb.so        # FalkorDB module v4.16.3 (ELF x86-64, ~37 MB)
    redis-server       # Redis 8.2.3 from falkordb/falkordb:v4.16.3 Docker (ELF x86-64, ~17 MB)
```

## How they are wired

`ts/src/backends/falkordblite.ts` `connect()` resolves the vendored
`falkordb.so` + `redis-server` for the current platform and passes them
explicitly to `FalkorDB.open({ modulePath, redisServerPath })`. This makes
the `falkordblite` package's own `BinaryManager.ensureBinaries()` skip its
network-download path entirely — the user-supplied paths short-circuit it.

A belt-and-suspenders `ts/scripts/vendor-postinstall.js` (wired as the
root `postinstall` in `ts/package.json`) also copies the vendored binaries
into `node_modules/falkordblite/bin/<platform>/` if they are missing, so
direct `falkordblite` package users (who bypass our backend wiring) get the
offline binaries too. Neither step touches the network.

`falkordblite` is intentionally NOT listed in `ts/package.json`
`trustedDependencies`, so bun does not run the `falkordblite` sub-package's
own postinstall (which would attempt a GitHub-release download). Our
root postinstall + runtime wiring fully cover the offline path.

## Platform support

Only `darwin-arm64` and `linux-x64` are vendored. On any other platform
(e.g. `linux-arm64`, `win32-x64`), `falkordblite.ts` falls through to the
`falkordblite` package's own binary resolution so those platforms keep
whatever behavior they had before (they are not broken by this change,
they simply are not offline-vendored).

## Dynamic-library expectations (end-user machine)

These vendored binaries are dynamically linked and expect a few shared
libraries to be present on the end-user machine. We do NOT bundle the
shared libraries themselves (that would mean bundling Homebrew / glibc);
we document the expectation here.

### darwin-arm64

`redis-server` (Homebrew Redis 8.8.0) is linked against:
- `/usr/lib/libSystem.B.dylib` (always present on macOS)
- `/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib` (brew `openssl@3`)
- `/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib` (brew `openssl@3`)

`falkordb.so` (FalkorDB module v4.16.3) is linked against:
- `/opt/homebrew/opt/libomp/lib/libomp.dylib` (brew `libomp`, keg-only)
- `libssl.3.dylib` / `libcrypto.3.dylib` (brew `openssl@3`, same as above)

End-user install expectation on darwin-arm64: `brew install openssl@3 libomp`
(or equivalent) so the dylibs resolve. The brew keg-only paths
`/opt/homebrew/opt/openssl@3/lib/...` and `/opt/homebrew/opt/libomp/lib/...`
are baked into the binaries as rpath entries; on Apple Silicon they are
the standard Homebrew locations.

### linux-x64

`redis-server` (Redis 8.2.3, extracted from `falkordb/falkordb:v4.16.3`
Docker, built for GNU/Linux 3.2.0) is dynamically linked against:
- `/lib64/ld-linux-x86-64.so.2` (glibc dynamic linker)
- `libssl.so.3` / `libcrypto.so.3` (OpenSSL 3)
- `libstdc++.so.6`, `libm.so.6`, `libc.so.6`, `libpthread.so.0`,
  `libdl.so.2`, `librt.so.1` (standard glibc / libstdc++)

`falkordb.so` (FalkorDB module v4.16.3, linux-x64) is dynamically linked
against the same glibc / libstdc++ / libssl / libcrypto / libgomp family.

End-user install expectation on linux-x64: a recent glibc (>= 2.17),
`libssl3` / `libcrypto3` (OpenSSL 3), `libstdc++6`, and `libgomp1` (GNU
OpenMP). On Debian/Ubuntu: `apt install libssl3 libstdc++6 libgomp1`. On
RHEL/Fedora: `dnf install openssl-libs libstdc++ libgomp`. These are
pre-installed on virtually all modern Linux distributions.

## Re-vendoring (mission maintainers only)

If a FalkorDB or Redis bump is ever needed:

- **darwin-arm64 `falkordb.so`:** copy from
  `node_modules/falkordblite/bin/darwin-arm64/falkordb.so` after running
  the falkordblite postinstall once (or download from the
  `FalkorDB/FalkorDB` GitHub release `falkordb-macos-arm64v8.so` and
  rename to `falkordb.so`).
- **darwin-arm64 `redis-server`:** copy from
  `/opt/homebrew/Cellar/redis/<version>/bin/redis-server` (Homebrew).
- **linux-x64 `falkordb.so`:** extract from the FalkorDB GitHub release
  `falkordb-x64.so` (rename to `falkordb.so`) or from the
  `falkordb/falkordb:v4.16.3` Docker image.
- **linux-x64 `redis-server`:** extract from the
  `falkordb/falkordb:v4.16.3` Docker image (`/usr/local/bin/redis-server`).

This re-vendoring is a one-time, mission-maintainer action that touches
the network; end-user installs never repeat it.
