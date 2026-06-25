/**
 * node-pty ships prebuilt binaries, but npm's tarball extraction can drop the
 * executable bit on the `spawn-helper` used to fork PTYs on macOS/Linux. Without
 * +x, `pty.spawn` fails with "posix_spawnp failed". This restores it after every
 * install (wired as `postinstall`). No-op on Windows and when node-pty is absent.
 */

import { chmodSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const base = resolve("node_modules/node-pty/prebuilds");
if (process.platform !== "win32" && existsSync(base)) {
  for (const dir of readdirSync(base)) {
    const helper = resolve(base, dir, "spawn-helper");
    if (existsSync(helper)) {
      try {
        chmodSync(helper, 0o755);
      } catch {
        /* best-effort */
      }
    }
  }
}
