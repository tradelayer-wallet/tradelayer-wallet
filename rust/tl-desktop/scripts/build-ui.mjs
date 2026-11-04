// Build the Angular wallet UI (packages/wallet-fe, configuration "tauri") into rust/tl-desktop/dist-ui.
//
// Usage: node scripts/build-ui.mjs [work dir]
//        node scripts/build-ui.mjs --ref <git-ref> --name <overlay name> [work dir]
//        node scripts/build-ui.mjs --ref <git-ref> --name <overlay name> --skin <skin name> [work dir]
//
// The second form builds the wallet UI of another git ref (for example origin/FE-speed) into
// dist-ui-<name>/: packages/wallet-fe and the root package.json/package-lock.json are exported with
// `git archive`, ui-overlay/<name>/ is applied (overlay.json: files copied over the sources and an
// angular.json "tauri" configuration; rewrites.json: exact string replacements with expected match
// counts, a differing count fails the build; "bases": SHA-256 of the files the overlay files were derived
// from, checked before they are replaced) and ui-shim/<name>-shim.js is injected.
// --skin <skin name> applies a second overlay layer, ui-overlay/<skin name>/, after the base layer (same
// overlay.json/rewrites.json format; overlay.json "angular.extraStyles" appends global stylesheets to the
// "tauri" configuration, "bitcorn" bundles BitcornWisdom's chart from a pinned commit, see
// bitcorn-bundle.mjs) and writes dist-ui-<skin name>/ so the base build stays untouched. Options
// --bitcorn-dir <clone> and --bitcorn-allow-other (build from the clone's HEAD instead of the pinned commit).
// The repository checkout is never modified except for dist-ui: sources are mirrored into the work
// dir (default %TEMP%/tl-desktop-ui-build, keeping the monorepo layout that info-line.component
// needs for the root package.json), dependencies are installed there with lifecycle scripts
// disabled, and the build output is copied back.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleBitcorn } from "./bitcorn-bundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const crate = resolve(here, "..");
const repo = resolve(crate, "..", "..");
const args = parseArgs(process.argv.slice(2));
const work = resolve(args.work || join(tmpdir(), args.ref ? `tl-desktop-ui-build-${args.skin || args.name}` : "tl-desktop-ui-build"));
const fe = join(work, "packages", "wallet-fe");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, args, cwd, env = {}) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });

mkdirSync(fe, { recursive: true });
const overlay = args.ref ? exportRef(args.ref, args.name, args.skin) : null;
if (!overlay) {
  cpSync(join(repo, "package.json"), join(work, "package.json"));
  for (const f of ["angular.json", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.app.json"]) {
    cpSync(join(repo, "packages", "wallet-fe", f), join(fe, f));
  }
  rmSync(join(fe, "src"), { recursive: true, force: true });
  cpSync(join(repo, "packages", "wallet-fe", "src"), join(fe, "src"), { recursive: true });
}

// wallet-fe's lockfile lacks the macOS-only optional entries (fsevents), so `npm ci` refuses it;
// `npm install` keeps every locked version. moment and socket.io-client are imported by wallet-fe
// but declared in the root package.json; install them at the root lockfile's exact versions.
if (!existsSync(join(fe, "node_modules", "@angular", "cli"))) {
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], fe);
}
const rootLockFile = overlay ? overlay.rootLock : "package-lock.json";
const rootLockJson = JSON.parse(readFileSync(join(overlay ? work : repo, rootLockFile), "utf8"));
// lockfileVersion 2/3 list "packages"; version 1 (FE-speed's npm-shrinkwrap.json) lists "dependencies"
const lockedVersion = (n) => {
  const v = rootLockJson.packages ? rootLockJson.packages[`node_modules/${n}`]?.version : rootLockJson.dependencies?.[n]?.version;
  if (!v) throw new Error(`${n} is not in ${rootLockFile}`);
  return v;
};
const hoisted = [...new Set(["moment", "socket.io-client", "engine.io-client", "socket.io-parser", ...(overlay ? overlay.hoist : [])])]
  .map((n) => `${n}@${lockedVersion(n)}`);
run(npm, ["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", ...hoisted], fe);

// Angular 12's webpack uses md4, which Node >= 17 only offers through the legacy provider.
run(process.execPath, [join(fe, "node_modules", "@angular", "cli", "bin", "ng"), "build", "--configuration", "tauri", "--output-path", "out-tauri"], fe,
  { NODE_OPTIONS: "--openssl-legacy-provider" });

const dist = join(crate, overlay ? `dist-ui-${args.skin || args.name}` : "dist-ui");
rmSync(dist, { recursive: true, force: true });
cpSync(join(fe, "out-tauri"), dist, { recursive: true });
injectShim(dist, overlay ? `${args.name}-shim.js` : "electron-shim.js");
if (overlay?.skin?.cfg.bitcorn) {
  bundleBitcorn({ cfg: overlay.skin.cfg.bitcorn, overlayDir: overlay.skin.dir, dist, git: findGit(), dirOverride: args.bitcornDir, allowOther: args.bitcornAllowOther });
}
console.log(`UI_BUILD_OK ${dist}`);

// wallet-fe expects Electron's window.require('electron') (master) or window.tradelayerElectron
// (FE-speed); load the matching ui-shim/<file> (a same-origin classic script, so it runs before the
// deferred module bundles) ahead of them.
export function injectShim(dir, file = "electron-shim.js") {
  cpSync(join(crate, "ui-shim", file), join(dir, file));
  const indexPath = join(dir, "index.html");
  const html = readFileSync(indexPath, "utf8");
  if (html.includes(file)) return;
  const at = html.indexOf("<script");
  if (at < 0) throw new Error("index.html has no script tag");
  writeFileSync(indexPath, html.slice(0, at) + `<script src="${file}"></script>` + html.slice(at));
}

function parseArgs(argv) {
  const out = { ref: null, name: null, skin: null, work: null, bitcornDir: null, bitcornAllowOther: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ref") out.ref = argv[++i];
    else if (argv[i] === "--name") out.name = argv[++i];
    else if (argv[i] === "--skin") out.skin = argv[++i];
    else if (argv[i] === "--bitcorn-dir") out.bitcornDir = argv[++i];
    else if (argv[i] === "--bitcorn-allow-other") out.bitcornAllowOther = true;
    else if (argv[i].startsWith("--")) throw new Error(`unknown option ${argv[i]}`);
    else out.work = argv[i];
  }
  if (out.ref && !out.name) throw new Error("--ref needs --name <overlay name>");
  if (out.name && !out.ref) throw new Error("--name needs --ref <git-ref>");
  if (out.name && !/^[a-z0-9-]+$/.test(out.name)) throw new Error("--name must match [a-z0-9-]+");
  if (out.skin && !out.ref) throw new Error("--skin needs --ref and --name");
  if (out.skin && !/^[a-z0-9-]+$/.test(out.skin)) throw new Error("--skin must match [a-z0-9-]+");
  return out;
}

function findGit() {
  if (process.env.GIT) return process.env.GIT;
  const base = join(process.env.LOCALAPPDATA || "", "GitHubDesktop");
  if (existsSync(base)) {
    const apps = readdirSync(base).filter((d) => d.startsWith("app-")).sort();
    for (const a of apps.reverse()) {
      const g = join(base, a, "resources", "app", "git", "cmd", process.platform === "win32" ? "git.exe" : "git");
      if (existsSync(g)) return g;
    }
  }
  return "git";
}

// Export <ref> into the work dir, then apply ui-overlay/<name>. Returns { hoist, rootLock }.
function exportRef(ref, name, skin) {
  const dir = join(crate, "ui-overlay", name);
  const overlayCfg = JSON.parse(readFileSync(join(dir, "overlay.json"), "utf8"));
  const rewrites = JSON.parse(readFileSync(join(dir, "rewrites.json"), "utf8")).rewrites;
  const git = findGit();
  const tarFile = join(work, `${name}-export.tar`);
  rmSync(join(fe, "src"), { recursive: true, force: true });
  // the root lockfile is package-lock.json, or npm-shrinkwrap.json on refs that publish one
  const tracked = execFileSync(git, ["-C", repo, "ls-tree", "--name-only", ref], { encoding: "utf8" }).split("\n").map((f) => f.trim());
  const rootLock = ["npm-shrinkwrap.json", "package-lock.json"].find((f) => tracked.includes(f));
  if (!rootLock) throw new Error(`${ref} has no root npm-shrinkwrap.json or package-lock.json`);
  execFileSync(git, ["-C", repo, "archive", "--format=tar", "-o", tarFile, ref, "package.json", rootLock, "packages/wallet-fe"], { stdio: "inherit" });
  // relative archive name + cwd: GNU tar reads "C:\..." as a remote host spec
  execFileSync("tar", ["-xf", `${name}-export.tar`], { cwd: work, stdio: "inherit" });
  rmSync(tarFile, { force: true });
  console.log(`exported ${ref} (${execFileSync(git, ["-C", repo, "rev-parse", "--short", ref]).toString().trim()}) into ${work}`);

  // An overlay file replaces a source file of the ref. overlay.json "bases" gives the SHA-256 of the
  // original (line ends normalized) that the overlay was derived from; a ref whose file differs fails
  // the build instead of silently dropping its changes.
  for (const [to, sha] of Object.entries(overlayCfg.bases || {})) {
    const original = readFileSync(join(fe, to), "utf8").replace(/\r\n/g, "\n");
    const actual = createHash("sha256").update(original).digest("hex");
    if (actual !== sha) throw new Error(`overlay base ${to}: the ref's file has SHA-256 ${actual}, the overlay was derived from ${sha}; rebase ui-overlay/${name}`);
  }
  for (const [from, to] of Object.entries(overlayCfg.files)) {
    cpSync(join(dir, from), join(fe, to));
    console.log(`overlay ${from} -> ${to}`);
  }
  patchAngularJson(overlayCfg.angular);
  applyRewrites(rewrites);
  // The skin layer: files, base checks and rewrites like the base layer, applied after it.
  let skinLayer = null;
  if (skin) {
    const skinDir = join(crate, "ui-overlay", skin);
    const skinCfg = JSON.parse(readFileSync(join(skinDir, "overlay.json"), "utf8"));
    const skinRewrites = existsSync(join(skinDir, "rewrites.json")) ? JSON.parse(readFileSync(join(skinDir, "rewrites.json"), "utf8")).rewrites : [];
    for (const [to, sha] of Object.entries(skinCfg.bases || {})) {
      const actual = createHash("sha256").update(readFileSync(join(fe, to), "utf8").replace(/\r\n/g, "\n")).digest("hex");
      if (actual !== sha) throw new Error(`skin base ${to}: the file has SHA-256 ${actual}, the skin was derived from ${sha}; rebase ui-overlay/${skin}`);
    }
    for (const [from, to] of Object.entries(skinCfg.files || {})) {
      mkdirSync(dirname(join(fe, to)), { recursive: true });
      cpSync(join(skinDir, from), join(fe, to));
      console.log(`skin ${from} -> ${to}`);
    }
    extendAngularJson(skinCfg.angular || {});
    applyRewrites(skinRewrites);
    skinLayer = { dir: skinDir, cfg: skinCfg };
  }
  return { hoist: [...(overlayCfg.hoist || []), ...(skinLayer?.cfg.hoist || [])], rootLock, skin: skinLayer };
}

function applyRewrites(rewrites) {
  for (const r of rewrites) {
    const file = join(fe, r.file);
    const text = readFileSync(file, "utf8");
    const count = text.split(r.from).length - 1;
    if (count !== r.count) throw new Error(`rewrite ${r.file}: expected ${r.count} match(es) of ${JSON.stringify(r.from)}, found ${count}`);
    writeFileSync(file, text.split(r.from).join(r.to));
    console.log(`rewrite ${r.file} x${count}: ${r.reason}`);
  }
}

// A skin layer may append global stylesheets to the "tauri" configuration (src/ paths, after the
// base styles).
function extendAngularJson(cfg) {
  if (!cfg.extraStyles?.length) return;
  const p = join(fe, "angular.json");
  const json = JSON.parse(readFileSync(p, "utf8"));
  const build = json.projects["wallet-fe"].architect.build;
  const tauri = build.configurations.tauri;
  tauri.styles = [...(tauri.styles || build.options.styles), ...cfg.extraStyles];
  writeFileSync(p, JSON.stringify(json, null, 2));
  console.log(`angular.json: tauri styles += ${cfg.extraStyles.join(", ")}`);
}

// Adds the "tauri" build configuration: the "production" configuration with the environment file
// replaced and critical-CSS/font inlining off (no inline event handlers under script-src 'self').
function patchAngularJson(cfg) {
  const p = join(fe, "angular.json");
  const json = JSON.parse(readFileSync(p, "utf8"));
  const build = json.projects["wallet-fe"].architect.build;
  const prod = build.configurations.production || {};
  build.configurations.tauri = {
    ...prod,
    ...(cfg.budgets ? { budgets: cfg.budgets } : {}),
    fileReplacements: [{ replace: "src/environments/environment.ts", with: cfg.environmentFile }],
    optimization: { scripts: true, styles: { minify: true, inlineCritical: false }, fonts: false },
    outputHashing: "all",
  };
  writeFileSync(p, JSON.stringify(json, null, 2));
  console.log("angular.json: added configuration tauri");
}
