"use strict";
// Bundled, trusted UI. Every value from Rust is written with textContent, never as HTML.
// Amounts cross the boundary as integer satoshis; decimal text is converted here exactly,
// without floating point.

const invoke = window.__TAURI__.core.invoke;
const $ = (id) => document.getElementById(id);
const VIEWS = ["view-setup", "view-backup", "view-unlock", "view-wallet"];

let currentPlan = null;

function show(view) {
  for (const v of VIEWS) $(v).hidden = v !== view;
  $("btn-lock").hidden = view !== "view-wallet";
}

function setError(err) {
  const el = $("error");
  if (!err) { el.hidden = true; el.textContent = ""; return; }
  el.textContent = typeof err === "string" ? err : (err.message || JSON.stringify(err));
  el.hidden = false;
}

async function call(cmd, args) {
  setError(null);
  try {
    return await invoke(cmd, args || {});
  } catch (e) {
    setError(e);
    throw e;
  }
}

async function busy(button, fn) {
  button.disabled = true;
  try { return await fn(); } catch (_) { return undefined; } finally { button.disabled = false; }
}

// "1.5" -> 150000000n. Accepts digits with at most 8 decimals, nothing else.
function coinsToSats(text) {
  const t = text.trim();
  if (!/^\d{1,8}(\.\d{1,8})?$/.test(t)) throw new Error("Amount must be a number with at most 8 decimals");
  const [whole, frac = ""] = t.split(".");
  const sats = BigInt(whole) * 100000000n + BigInt((frac + "00000000").slice(0, 8));
  if (sats <= 0n) throw new Error("Amount must be positive");
  return sats;
}

function satsToCoins(sats) {
  const s = BigInt(sats);
  const whole = s / 100000000n;
  const frac = (s % 100000000n).toString().padStart(8, "0");
  return `${whole}.${frac}`;
}

async function refreshStatus() {
  const st = await call("status");
  $("chip-network").textContent = st.network_id;
  const node = $("chip-node");
  node.className = "chip " + (st.chain_matches ? "good" : "bad");
  node.textContent = st.node_chain ? `node ${st.node_chain}` : "node offline";
  if (!st.has_vault) show("view-setup");
  else if (!st.unlocked) show("view-unlock");
  else { show("view-wallet"); await refreshWallet(); }
  return st;
}

async function refreshWallet() {
  $("receive-address").textContent = await call("receive_address");
  const b = await call("balance");
  $("bal-confirmed").textContent = satsToCoins(b.confirmed_sats);
  $("bal-utxos").textContent = String(b.utxo_count);
  $("bal-height").textContent = String(b.height);
  $("bal-immature").textContent = satsToCoins(b.immature_sats);
  $("bal-immature-row").hidden = b.immature_sats === 0;
}

function showBackup(phrase) {
  const ol = $("backup-words");
  ol.replaceChildren();
  for (const w of phrase.split(" ")) {
    const li = document.createElement("li");
    li.textContent = w;
    ol.appendChild(li);
  }
  show("view-backup");
}

function clearPreview() {
  currentPlan = null;
  $("preview").hidden = true;
}

$("btn-create").addEventListener("click", (e) => busy(e.target, async () => {
  const p = $("create-pass").value;
  if (p !== $("create-pass2").value) { setError("Passwords differ"); return; }
  const phrase = await call("create_wallet", { password: p });
  $("create-pass").value = ""; $("create-pass2").value = "";
  showBackup(phrase);
}));

$("btn-backup-done").addEventListener("click", async () => {
  $("backup-words").replaceChildren();
  await refreshStatus();
});

$("btn-import").addEventListener("click", (e) => busy(e.target, async () => {
  await call("import_wallet", { phrase: $("import-phrase").value, password: $("import-pass").value });
  $("import-phrase").value = ""; $("import-pass").value = "";
  await refreshStatus();
}));

$("btn-unlock").addEventListener("click", (e) => busy(e.target, async () => {
  await call("unlock", { password: $("unlock-pass").value });
  $("unlock-pass").value = "";
  await refreshStatus();
}));

$("btn-lock").addEventListener("click", async () => {
  await call("lock");
  clearPreview();
  $("sent").hidden = true;
  await refreshStatus();
});

$("btn-refresh").addEventListener("click", (e) => busy(e.target, refreshWallet));

$("btn-copy").addEventListener("click", () => {
  navigator.clipboard.writeText($("receive-address").textContent).catch(() => {});
});

$("btn-prepare").addEventListener("click", (e) => busy(e.target, async () => {
  clearPreview();
  $("sent").hidden = true;
  let amountSats;
  try { amountSats = coinsToSats($("send-amount").value); } catch (err) { setError(err); return; }
  const feeText = $("send-fee").value.trim();
  if (feeText !== "" && !/^\d{1,6}$/.test(feeText)) { setError("Fee rate must be a whole number of sat/vB"); return; }
  // amountSats is at most 99999999.99999999 coins = < 2^53 sats, so Number is exact.
  const pv = await call("prepare_send", {
    to: $("send-to").value.trim(),
    amountSats: Number(amountSats),
    feeRate: feeText === "" ? null : Number(feeText),
  });
  currentPlan = pv.plan_id;
  $("pv-to").textContent = pv.to;
  $("pv-amount").textContent = satsToCoins(pv.amount_sats);
  $("pv-fee").textContent = satsToCoins(pv.fee_sats);
  $("pv-rate").textContent = `${pv.fee_rate_sat_vb} sat/vB`;
  $("pv-change").textContent = satsToCoins(pv.change_sats);
  $("pv-inputs").textContent = String(pv.input_count);
  $("pv-expiry").textContent = new Date(pv.expires_at_ms).toLocaleTimeString();
  $("preview").hidden = false;
}));

$("btn-confirm").addEventListener("click", (e) => busy(e.target, async () => {
  if (!currentPlan) return;
  const plan = currentPlan;
  clearPreview();
  const r = await call("confirm_send", { planId: plan });
  $("sent-txid").textContent = r.txid;
  $("sent").hidden = false;
  $("send-to").value = ""; $("send-amount").value = ""; $("send-fee").value = "";
  await refreshWallet();
}));

$("btn-cancel").addEventListener("click", async () => {
  if (currentPlan) await call("cancel_send", { planId: currentPlan });
  clearPreview();
});

refreshStatus().catch(() => {});
