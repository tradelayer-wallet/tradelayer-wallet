// WCAG 2.x contrast check for the fe-speed-skin palette (ui-overlay/fe-speed-skin/styles-skin.scss).
// Usage: node scripts/check-skin-contrast.mjs   -> prints every pair, exits 1 when one is under its minimum.
// The --sk-* hex tokens come from the stylesheet; gradient stops are listed here next to the text that
// sits on them (the lightest and darkest stop of a gradient are both checked).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ui-overlay", "fe-speed-skin", "styles-skin.scss"), "utf8");
const token = (n) => { const m = scss.match(new RegExp(`--${n}: *(#[0-9a-fA-F]{6})`)); if (!m) throw new Error(`token --${n} missing`); return m[1]; };
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const text = token("sk-text"), dim = token("sk-text-dim"), bg = token("sk-bg"), violet = token("sk-violet"), panel = token("sk-panel");
const panelHi = token("sk-panel-hi"), ink = token("sk-ink-on-steel"), tradeInk = token("sk-ink-on-trade");
const chrome = ["#f2f5fc", "#c9d1e6", "#8993b2", "#aeb8d2", "#dde3f1"]; // --sk-chrome stops
const buy = ["#4fdc8b", "#36c970", "#2aae5f"], sell = ["#f57373", "#ef5252", "#dc4141"];
const lightBlueTab = ["#a6d6ff", "#6bbcff", "#45a8fb"];
const barStops = ["#3a4066", "#272b49", "#181b30", "#1b1e34"];
const pairs = [
  ["body text on page background", text, bg, 4.5], ["body text on panel", text, panel, 4.5], ["body text on dialog (violet)", text, violet, 4.5],
  ["body text on raised panel", text, panelHi, 4.5],
  ["dim text on panel", dim, panel, 4.5], ["dim text on page background", dim, bg, 4.5],
  ["white (nav, header text) on every header/status bar stop", "#ffffff", barStops, 4.5],
  ["status SYNCED #6fb7ff on bar", "#6fb7ff", barStops, 4.5], ["status NOT STARTED #ff9d9d on bar", "#ff9d9d", barStops, 4.5],
  ["primary button ink on chrome", ink, chrome, 4.5], ["chart pill ink on chrome pill", ink, ["#e6ebf6", "#aab4cf"], 4.5],
  ["Buy/Long ink on green gradient", tradeInk, buy, 4.5], ["Sell/Short ink on red gradient", tradeInk, sell, 4.5],
  ["selected market tab ink on light-blue chrome", ink, lightBlueTab, 4.5],
  ["buy price text #4be08b on panel", "#4be08b", panel, 4.5], ["sell price text #ff7b7b on panel", "#ff7b7b", panel, 4.5],
  ["chart axis labels #a9b2d6 on axis #23274a", "#a9b2d6", "#23274a", 4.5], ["chart price tag ink on tag #d4daea", "#0b1230", "#d4daea", 4.5],
  ["chart accent #45a8fb on embed surface #23274a", "#45a8fb", "#23274a", 4.5], ["chart muted #aab1d0 on embed surface", "#aab1d0", "#23274a", 4.5],
  ["window title (white) on header stops", "#ffffff", barStops, 4.5],
  ["window body black text on light steel", "#000000", ["#f6f7fb", "#e4e7f2"], 4.5],
  ["Terminate/warn #b0201a on light steel", "#b0201a", ["#f6f7fb", "#e4e7f2"], 4.5],
  ["dialog warn button #ff8a8a on violet", "#ff8a8a", violet, 4.5],
];
let bad = 0;
for (const [name, fg, bgs, min] of pairs) {
  const list = Array.isArray(bgs) ? bgs : [bgs];
  const worst = Math.min(...list.map((b) => ratio(fg, b)));
  const ok = worst >= min;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"} ${worst.toFixed(2)}:1 (min ${min}) ${name}`);
}
console.log(bad ? `CONTRAST_FAIL ${bad}` : "CONTRAST_OK");
process.exit(bad ? 1 : 0);
