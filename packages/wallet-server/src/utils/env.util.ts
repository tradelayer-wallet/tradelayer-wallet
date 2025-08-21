// env.util.ts
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export type Chain = 'BTC' | 'LTC';
export type Network = 'mainnet' | 'testnet' | 'regtest' | 'signet';

export function envPath(): string {
  // project root .env by default; override with ENV_PATH if you want
  const p = process.env.ENV_PATH || resolve(process.cwd(), '.env');
  return p;
}

export function loadEnvIntoProcess(): void {
  // Safe, idempotent; doesn’t throw if file missing
  try {
    const p = envPath();
    if (existsSync(p)) {
      require('dotenv').config({ path: p });
    }
  } catch (_) {}
}

export function readEnvFile(): string {
  const p = envPath();
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8');
}

export function upsertEnvKV(content: string, key: string, value: string): string {
  const lines = content ? content.split(/\r?\n/) : [];
  const idx = lines.findIndex(l => l.trim().startsWith(`${key}=`));
  const line = `${key}=${value}`;
  if (idx === -1) {
    lines.push(line);
  } else {
    lines[idx] = line;
  }
  return lines.filter(l => l.trim().length > 0).join('\n') + '\n';
}

export function writeEnvKVs(kvs: Record<string,string|number|boolean|undefined|null>): void {
  let content = readEnvFile();
  for (const [k, v] of Object.entries(kvs)) {
    if (v === undefined || v === null) continue;
    content = upsertEnvKV(content, k, String(v));
    // also apply to live process for immediate use
    process.env[k] = String(v);
  }
  writeFileSync(envPath(), content, 'utf8');
}

export function parseDefaultChain(label: string): { chain: Chain; network: Network } {
  // Accepts "BTCLIVE", "BTCTEST", "LTCLIVE", "LTCTEST" (your current labels)
  const u = (label || '').toUpperCase();
  const chain: Chain = u.includes('LTC') ? 'LTC' : 'BTC';
  const network: Network = u.includes('TEST') ? 'testnet' : 'mainnet';
  return { chain, network };
}

export function defaultRpcPort(chain: Chain, network: Network): number {
  if (chain === 'LTC') {
    if (network === 'mainnet') return 9332;
    if (network === 'testnet') return 19332;
    if (network === 'regtest') return 19443;
  } else {
    if (network === 'mainnet') return 8332;
    if (network === 'testnet') return 18332;
    if (network === 'regtest') return 18443;
    if (network === 'signet')  return 38332;
  }
  return 8332;
}
