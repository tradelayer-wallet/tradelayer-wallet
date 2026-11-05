// Merge ui-overlay/<skin>/csp.json into a base Content-Security-Policy string.
//
// Usage: node scripts/skin-csp.mjs <base csp | @file holding it> [--skin fe-speed-skin] [--dist dist-ui-fe-speed-skin] [--no-replace] [--connect <source>]...
//   prints a TAURI_CONFIG JSON ({"build":{"frontendDist"},"app":{"security":{"csp"}}}) for cargo build
//   when --dist is given, otherwise the merged CSP string. tauri.conf.json itself is not touched.
//
// --connect <source> (repeatable) adds one more connect-src source, for a test build that talks to a local orderbook.
// csp.json lists extra sources per directive ({source, reason}); "replace" entries swap an exact
// substring of the base CSP and are skipped with --no-replace.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const crate = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = argv.indexOf(name); if (i < 0) return fallback; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const skin = opt("--skin", "fe-speed-skin");
const dist = opt("--dist");
const extraConnect = [];
for (let i; (i = argv.indexOf("--connect")) >= 0;) extraConnect.push(...argv.splice(i, 2).slice(1));
const noReplace = argv.includes("--no-replace");
if (noReplace) argv.splice(argv.indexOf("--no-replace"), 1);
const base = argv[0]?.startsWith("@") ? readFileSync(argv[0].slice(1), "utf8").trim() : argv[0];
if (!base) { console.error("usage: skin-csp.mjs <base csp> [--skin name] [--dist dir] [--no-replace]"); process.exit(2); }

const cfg = JSON.parse(readFileSync(join(crate, "ui-overlay", skin, "csp.json"), "utf8"));
let csp = base;
if (!noReplace) {
  for (const r of cfg.replace || []) {
    if (csp.includes(r.from)) csp = csp.split(r.from).join(r.to);
  }
}
const directives = csp.split(";").map((d) => d.trim()).filter(Boolean);
for (const dir of ["connect-src", "frame-src", "img-src"]) {
  const add = [...(cfg[dir] || []).map((e) => e.source), ...(dir === "connect-src" ? extraConnect : [])];
  if (!add.length) continue;
  const i = directives.findIndex((d) => d.startsWith(`${dir} `));
  if (i >= 0) directives[i] = [...new Set([...directives[i].split(/\s+/), ...add])].join(" ");
  else directives.push(`${dir} ${add.join(" ")}`);
}
const merged = directives.join("; ");
if (dist) console.log(JSON.stringify({ build: { frontendDist: dist }, app: { security: { csp: merged } } }));
else console.log(merged);
