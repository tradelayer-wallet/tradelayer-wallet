// Copies BitcornWisdom's embeddable chart (embed.html, embed.css, the ES modules it imports, licence
// and third-party notices) from a pinned commit of a local clone into <dist>/<dest>/, so the wallet
// never fetches chart code at runtime (no GitHub Pages, no CDN).
//
// Used by build-ui.mjs for overlays whose overlay.json has a "bitcorn" section:
//   { "commit": "<40-hex>",          the only commit the build accepts
//     "dest": "bitcorn",             sub-path in the built UI
//     "defaultDirs": ["C:/..."],     clone locations tried in order (env BITCORN_WISDOM_DIR or --bitcorn-dir first)
//     "roots": ["embed.html", ...],  files to take; every ./x.js imported by a root .js is taken too
//     "extra": ["LICENSE", ...],     files taken as they are
//     "patches": [ { file, from, to | toFile, count, reason } ] }
// The build fails when no clone is found, when its HEAD is another commit (unless the caller passes
// allowOther, which then takes HEAD), or when a patch does not match exactly `count` times. Files are read
// from git objects (`git show <commit>:<path>`), never from the working tree, so local edits to the clone
// cannot leak into the bundle. <dest>/PROVENANCE.json records the commit, every file's SHA-256 and the
// patches applied.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function bundleBitcorn({ cfg, overlayDir, dist, git, dirOverride = null, allowOther = false }) {
  const candidates = [dirOverride, process.env.BITCORN_WISDOM_DIR, ...(cfg.defaultDirs || [])].filter(Boolean);
  const dir = candidates.find((d) => existsSync(join(d, ".git")));
  if (!dir) throw new Error(`BitcornWisdom clone not found (tried ${candidates.join(", ") || "nothing"}); set BITCORN_WISDOM_DIR or --bitcorn-dir`);
  const run = (...a) => execFileSync(git, ["-C", dir, ...a], { maxBuffer: 64 << 20 });
  const head = run("rev-parse", "HEAD").toString().trim();
  if (!/^[0-9a-f]{40}$/.test(cfg.commit)) throw new Error("bitcorn.commit must be a full 40-hex commit");
  if (head !== cfg.commit && !allowOther) {
    throw new Error(`BitcornWisdom clone ${dir} is at ${head}, the build is pinned to ${cfg.commit}; check out the pinned commit or pass --bitcorn-allow-other`);
  }
  const ref = head === cfg.commit ? cfg.commit : head;
  if (ref !== cfg.commit) console.warn(`WARNING bitcorn: building from ${ref}, not the pinned ${cfg.commit}`);

  const show = (path) => {
    try { return run("show", `${ref}:${path}`); } catch (e) { throw new Error(`BitcornWisdom ${ref.slice(0, 7)} has no ${path}`); }
  };
  const files = new Map(); // path -> Buffer
  const take = (path) => {
    if (files.has(path)) return;
    const buf = show(path);
    files.set(path, buf);
    if (path.endsWith(".js")) {
      const text = buf.toString("utf8");
      for (const m of text.matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+\.js)['"]/g)) {
        take(posix.normalize(posix.join(posix.dirname(path), m[1])));
      }
    }
  };
  for (const p of [...cfg.roots, ...(cfg.extra || [])]) take(p);

  // patches: exact-count string replacements on the copied text
  const text = new Map([...files].map(([p, b]) => [p, b.toString("utf8").replace(/\r\n/g, "\n")]));
  const applied = [];
  for (const patch of cfg.patches || []) {
    const body = text.get(patch.file);
    if (body === undefined) throw new Error(`bitcorn patch: ${patch.file} is not part of the bundle`);
    const count = body.split(patch.from).length - 1;
    if (count !== patch.count) throw new Error(`bitcorn patch ${patch.file}: expected ${patch.count} match(es) of ${JSON.stringify(patch.from.slice(0, 80))}, found ${count}`);
    let to = patch.to ?? "";
    if (patch.toFile) to = readFileSync(join(overlayDir, patch.toFile), "utf8").replace(/\r\n/g, "\n");
    if (patch.toFile) to = to.endsWith("\n") ? to.slice(0, -1) : to;
    to = to.split("$FROM").join(patch.from);
    text.set(patch.file, body.split(patch.from).join(to));
    applied.push({ file: patch.file, count, reason: patch.reason });
    console.log(`bitcorn patch ${patch.file} x${count}: ${patch.reason}`);
  }

  const root = join(dist, cfg.dest);
  const manifest = [];
  for (const [path, buf] of files) {
    const out = text.has(path) ? Buffer.from(text.get(path), "utf8") : buf;
    const to = join(root, path);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, out);
    manifest.push({ path, sha256: sha256(out), upstreamSha256: sha256(buf) });
  }
  // never a runtime dependency on the project's hosted pages or a CDN
  for (const [path] of files) {
    const body = readFileSync(join(root, path), "utf8");
    const hit = body.match(/patrickdugan\.github\.io|cdn\.jsdelivr|unpkg\.com|cdnjs/);
    if (hit) throw new Error(`bitcorn bundle: ${path} references ${hit[0]}`);
  }
  writeFileSync(join(root, "PROVENANCE.json"), JSON.stringify({
    source: "https://github.com/patrickdugan/BitcornWisdom", commit: ref, pinned: cfg.commit,
    licence: "MIT (see LICENSE and THIRD_PARTY_NOTICES.md)", patches: applied, files: manifest,
  }, null, 2));
  console.log(`bitcorn: ${manifest.length} files from ${ref.slice(0, 7)} -> ${root}`);
  return { commit: ref, files: manifest.map((f) => f.path) };
}
