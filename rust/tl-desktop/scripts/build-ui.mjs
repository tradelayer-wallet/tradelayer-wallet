// Build the Angular wallet UI (packages/wallet-fe, configuration "tauri") into rust/tl-desktop/dist-ui.
//
// Usage: node scripts/build-ui.mjs [work dir]
// The repository checkout is never modified except for dist-ui: sources are mirrored into the work
// dir (default %TEMP%/tl-desktop-ui-build, keeping the monorepo layout that info-line.component
// needs for the root package.json), dependencies are installed there with lifecycle scripts
// disabled, and the build output is copied back.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const crate = resolve(here, "..");
const repo = resolve(crate, "..", "..");
const work = resolve(process.argv[2] || join(tmpdir(), "tl-desktop-ui-build"));
const fe = join(work, "packages", "wallet-fe");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, args, cwd, env = {}) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });

mkdirSync(fe, { recursive: true });
cpSync(join(repo, "package.json"), join(work, "package.json"));
for (const f of ["angular.json", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.app.json"]) {
  cpSync(join(repo, "packages", "wallet-fe", f), join(fe, f));
}
rmSync(join(fe, "src"), { recursive: true, force: true });
cpSync(join(repo, "packages", "wallet-fe", "src"), join(fe, "src"), { recursive: true });

// wallet-fe's lockfile lacks the macOS-only optional entries (fsevents), so `npm ci` refuses it;
// `npm install` keeps every locked version. moment and socket.io-client are imported by wallet-fe
// but declared in the root package.json; install them at the root lockfile's exact versions.
if (!existsSync(join(fe, "node_modules", "@angular", "cli"))) {
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], fe);
}
const rootLock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8")).packages;
const hoisted = ["moment", "socket.io-client", "engine.io-client", "socket.io-parser"]
  .map((n) => `${n}@${rootLock[`node_modules/${n}`].version}`);
run(npm, ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", ...hoisted], fe);

// Angular 12's webpack uses md4, which Node >= 17 only offers through the legacy provider.
run(process.execPath, [join(fe, "node_modules", "@angular", "cli", "bin", "ng"), "build", "--configuration", "tauri", "--output-path", "out-tauri"], fe,
  { NODE_OPTIONS: "--openssl-legacy-provider" });

const dist = join(crate, "dist-ui");
rmSync(dist, { recursive: true, force: true });
cpSync(join(fe, "out-tauri"), dist, { recursive: true });
injectShim(dist);
console.log(`UI_BUILD_OK ${dist}`);

// wallet-fe expects Electron's window.require('electron'); load ui-shim/electron-shim.js (a
// same-origin classic script, so it runs before the deferred module bundles) ahead of them.
export function injectShim(dir) {
  cpSync(join(crate, "ui-shim", "electron-shim.js"), join(dir, "electron-shim.js"));
  const indexPath = join(dir, "index.html");
  const html = readFileSync(indexPath, "utf8");
  if (html.includes("electron-shim.js")) return;
  const at = html.indexOf("<script");
  if (at < 0) throw new Error("index.html has no script tag");
  writeFileSync(indexPath, html.slice(0, at) + '<script src="electron-shim.js"></script>' + html.slice(at));
}
