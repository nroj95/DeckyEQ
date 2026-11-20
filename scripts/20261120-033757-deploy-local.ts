// SPDX-License-Identifier: BSD-3-Clause
// =====================================================================================================
// scripts/20261120-033757-deploy-local.ts — deploy this checkout into the local Decky install
// =====================================================================================================
// Personal helper for nroj95's DeckyEQ fork on a Legion Go S (SteamOS). Not part of upstream.
//
// What it does, in order:
//   1. `npm run build` (the frontend; the build already verifies dist/ with scripts/check-build.mjs).
//   2. Reads the runtime file list from package.json "decky.files" (the same list scripts/package.mjs
//      ships), expanding top-level `*` patterns such as `dk_*.py`.
//   3. Copies every entry into ~/homebrew/plugins/DeckyEQ with rsync (folders mirrored with --delete,
//      __pycache__ left alone), then checks each copied entry is identical to the checkout.
//   4. Restarts Decky (`sudo systemctl restart plugin_loader`) so the new frontend and backend load.
//      sudo asks for the deck password in your terminal. Skip with --no-restart.
//
// Special cases:
//   - Ownership: Decky re-owns the plugin folder (and plugin.json) as root on every start, but leaves
//     the files and subfolders inside to deck. So existing top-level files are updated in place
//     (rsync --inplace, no temp file in the root-owned folder), and only when an entry is NEW at the
//     top level does the script run `sudo chown deck:deck` on the folder first.
//   - bin/deckyeq_dsp.so: SteamOS ships no gcc, so a checkout usually has no built limiter. When it is
//     missing here, the installed one is kept (fine while native/ is unchanged since that build).
//   - plugin.json: stays root-owned in the install. It is skipped when identical; a changed plugin.json
//     stops the deploy, since Decky reads its flags (e.g. root) from it.
//
// Requirements: run on the Go S, in a terminal (sudo may ask for the deck password); DeckyEQ already
//   installed in Decky; Node with TypeScript stripping (Node 23.6+).
// Usage:  node scripts/20261120-033757-deploy-local.ts [--no-restart]
// Undo:   the official 1.1.0 install is backed up in ~/dev/DeckyEQ-installed-1.1.0
// =====================================================================================================

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(homedir(), "homebrew", "plugins", "DeckyEQ");
const KEEP_INSTALLED_IF_MISSING = new Set(["bin/deckyeq_dsp.so"]);
const ROOT_OWNED = new Set(["plugin.json"]);

const fail = (message: string): never => { console.error(`✗ ${message}`); process.exit(1); };
const run = (cmd: string, args: string[]) => {
  try { execFileSync(cmd, args, { cwd: REPO, stdio: "inherit" }); }
  catch { fail(`${cmd} ${args.join(" ")} failed`); }
};
const same = (a: string, b: string) => {
  try { execFileSync("diff", ["-rq", "-x", "__pycache__", a, b], { stdio: "ignore" }); return true; }
  catch { return false; }
};

if (!existsSync(TARGET)) fail(`no Decky install at ${TARGET}`);

// 1. Build
run("npm", ["run", "build", "--silent"]);

// 2. Runtime file list, as upstream packages it
const files: string[] = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).decky?.files
  ?? fail('package.json has no "decky.files"');
const entries = files.flatMap(entry => {
  if (!entry.includes("*")) return [entry];
  const pattern = new RegExp(`^${entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return readdirSync(REPO).filter(name => pattern.test(name));
});

// 3. Copy and verify (a new top-level entry needs the root-owned folder handed to deck first)
const isNew = (entry: string) => existsSync(join(REPO, entry)) && !existsSync(join(TARGET, entry.split("/")[0]));
if (entries.some(isNew) && statSync(TARGET).uid !== process.getuid!()) {
  console.log(`New top-level files: ${entries.filter(isNew).join(", ")}. Taking ownership of the folder (sudo)…`);
  run("sudo", ["chown", "deck:deck", TARGET]);
}
for (const entry of entries) {
  const source = join(REPO, entry), dest = join(TARGET, entry);
  if (!existsSync(source)) {
    if (KEEP_INSTALLED_IF_MISSING.has(entry) && existsSync(dest)) { console.log(`• keep installed ${entry}`); continue; }
    fail(`${entry} is missing in the checkout`);
  }
  if (ROOT_OWNED.has(entry)) {
    if (same(source, dest)) { console.log(`• ${entry} unchanged`); continue; }
    fail(`${entry} differs from the installed one; Decky keeps it root-owned, update it with sudo on purpose`);
  }
  const folder = statSync(source).isDirectory();
  execFileSync("mkdir", ["-p", dirname(dest)]);
  execFileSync("rsync", ["-a", ...(folder ? ["--delete", "--exclude", "__pycache__", `${source}/`, `${dest}/`] : ["--inplace", source, dest])]);
  if (!same(source, dest)) fail(`${entry} did not copy cleanly`);
  console.log(`✓ ${entry}${folder ? "/" : ""}`);
}

// 4. Reload Decky
if (process.argv.includes("--no-restart")) {
  console.log("Copied. Restart Decky yourself: sudo systemctl restart plugin_loader");
} else {
  console.log("Restarting Decky (sudo asks for the deck password)…");
  run("sudo", ["systemctl", "restart", "plugin_loader"]);
  console.log("✓ Deployed. Newest log: ~/homebrew/logs/DeckyEQ/");
}
