// Real-node proof that NodeWalletSigner signs a 2-of-2 channel multisig on DESCRIPTOR wallets.
// Starts a throwaway regtest node in a temp datadir, creates two descriptor wallets, runs the ignored
// cargo test `nodewallet::regtest_tests`, then stops the node it started and deletes the datadir.
//
//   node regtest-multisig-descriptor.mjs [--chain btc|ltc] [--port 18781]
//
// Environment:
//   BITCOIN_BIN   bin dir of Bitcoin Core (default %LOCALAPPDATA%/Programs/BitcoinCore/bitcoin-31.1/bin)
//   LITECOIN_BIN  bin dir of Litecoin Core (required for --chain ltc)
//   TL_CARGO      command that runs cargo with the build environment (default `cargo`); it receives
//                 `test --locked -- --ignored --nocapture <test>` and runs in rust/tl-desktop
// Only the node this script spawns is stopped (by its PID); no other process or datadir is touched.
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const chain = opt("chain", "btc");
const port = Number(opt("port", "18781"));
const CHAINS = {
  btc: {
    bin: process.env.BITCOIN_BIN || join(process.env.LOCALAPPDATA ?? "", "Programs/BitcoinCore/bitcoin-31.1/bin"),
    daemon: "bitcoind.exe",
    cli: "bitcoin-cli.exe",
    network: "BTCREGTEST",
  },
  ltc: {
    bin: process.env.LITECOIN_BIN || "",
    daemon: "litecoind.exe",
    cli: "litecoin-cli.exe",
    network: "LTCREGTEST",
  },
};
const cfg = CHAINS[chain];
if (!cfg) throw new Error(`--chain must be btc or ltc, got ${chain}`);
if (!cfg.bin || !existsSync(join(cfg.bin, cfg.daemon))) {
  throw new Error(`${cfg.daemon} not found in "${cfg.bin}" (set ${chain === "btc" ? "BITCOIN_BIN" : "LITECOIN_BIN"})`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const user = "tlregtest";
const pass = randomBytes(16).toString("hex");
const datadir = mkdtempSync(join(tmpdir(), `tl-multisig-${chain}-`));
const cliArgs = [`-datadir=${datadir}`, "-regtest", `-rpcport=${port}`, `-rpcuser=${user}`, `-rpcpassword=${pass}`];
const cli = (...a) => execFileSync(join(cfg.bin, cfg.cli), [...cliArgs, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const node = spawn(
  join(cfg.bin, cfg.daemon),
  [
    `-datadir=${datadir}`, "-regtest", "-listen=0", `-rpcport=${port}`, `-rpcuser=${user}`, `-rpcpassword=${pass}`,
    "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1", "-fallbackfee=0.0001", "-txindex=0",
  ],
  { stdio: "ignore", windowsHide: true },
);
console.log(`started ${cfg.daemon} pid ${node.pid} datadir ${datadir} rpcport ${port}`);

let stopped = false;
async function cleanup() {
  if (stopped) return;
  stopped = true;
  try { cli("stop"); } catch (_) { /* node may already be down */ }
  for (let i = 0; i < 80 && node.exitCode === null && node.signalCode === null; i++) await sleep(250);
  if (node.exitCode === null && node.signalCode === null) {
    try { execFileSync("taskkill", ["/PID", String(node.pid), "/T", "/F"], { stdio: "ignore" }); } catch (_) { /* gone */ }
    await sleep(500);
  }
  for (let i = 0; i < 20; i++) {
    try { rmSync(datadir, { recursive: true, force: true }); break; } catch (_) { await sleep(250); }
  }
  console.log(`stopped pid ${node.pid}; datadir ${existsSync(datadir) ? "NOT removed" : "removed"}`);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => cleanup().then(() => process.exit(130)));

let code = 1;
try {
  for (let i = 0; ; i++) {
    try { cli("getblockchaininfo"); break; } catch (e) { if (i > 120 || node.exitCode !== null) throw e; await sleep(250); }
  }
  console.log(cli("-version").split("\n")[0]);
  // positional: wallet_name, disable_private_keys, blank, passphrase, avoid_reuse, descriptors
  for (const w of ["tlA", "tlB"]) cli("createwallet", w, "false", "false", "", "false", "true");
  console.log("descriptor wallets:", cli("listwallets").replace(/\s+/g, " "));

  const here = dirname(fileURLToPath(import.meta.url));
  const crate = join(here, "..");
  const runner = process.env.TL_CARGO || "cargo";
  const testName = "nodewallet::regtest_tests::two_descriptor_wallets_sign_the_channel_multisig_and_the_spend_confirms";
  const r = spawnSync(
    `"${runner}" test --locked -- --ignored --nocapture ${testName}`,
    {
      cwd: crate,
      shell: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        TL_REGTEST_URL: `http://127.0.0.1:${port}`,
        TL_REGTEST_USER: user,
        TL_REGTEST_PASS: pass,
        TL_REGTEST_WALLET_A: "tlA",
        TL_REGTEST_WALLET_B: "tlB",
        TL_REGTEST_NETWORK: cfg.network,
      },
    },
  );
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  // a wrapper such as build-desktop.cmd can hide cargo's exit code, so the test's own result line counts too
  const passed = r.status === 0 && /^RESULT ok /m.test(r.stdout ?? "") && /test result: ok\. 1 passed/.test(r.stdout ?? "");
  code = passed ? 0 : 1;
  console.log(code === 0 ? "regtest multisig on descriptor wallets: PASS" : `regtest multisig on descriptor wallets: FAIL (exit ${code})`);
} catch (e) {
  console.error(String(e?.stderr || e?.message || e));
} finally {
  await cleanup();
}
process.exit(code);
