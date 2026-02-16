import { enc, RIPEMD160, SHA256 } from 'crypto-js';

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hexToBytes(hex: string): Uint8Array {
  const s = String(hex || '').trim();
  if (s.length % 2 !== 0) throw new Error('hex length must be even');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

function sha256Bytes(bytes: Uint8Array): Uint8Array {
  const wa = enc.Hex.parse(bytesToHex(bytes));
  const hex = SHA256(wa).toString(enc.Hex);
  return hexToBytes(hex);
}

function hash160Bytes(bytes: Uint8Array): Uint8Array {
  const wa = enc.Hex.parse(bytesToHex(bytes));
  const h1 = SHA256(wa).toString(enc.Hex);
  const h2 = RIPEMD160(enc.Hex.parse(h1)).toString(enc.Hex);
  return hexToBytes(h2);
}

function base58Decode(s: string): Uint8Array {
  const str = String(s || '').trim();
  if (!str) return new Uint8Array();

  const bytes: number[] = [0];
  for (const ch of str) {
    const v = B58_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('invalid base58 character');
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      const x = bytes[i] * 58 + carry;
      bytes[i] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  let leadingZeros = 0;
  for (const ch of str) {
    if (ch === '1') leadingZeros++;
    else break;
  }

  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i];
  return out;
}

function base58Encode(bytes: Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array();
  if (!b.length) return '';

  const digits: number[] = [0];
  for (const byte of b) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const x = digits[i] * 256 + carry;
      digits[i] = x % 58;
      carry = (x / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let leadingZeros = 0;
  for (const byte of b) {
    if (byte === 0) leadingZeros++;
    else break;
  }

  let out = '';
  for (let i = 0; i < leadingZeros; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

export function base58checkDecode(addr: string): { version: number; payload: Uint8Array } {
  const raw = base58Decode(addr);
  if (raw.length < 5) throw new Error('base58check too short');
  const version = raw[0];
  const payload = raw.slice(1, raw.length - 4);
  const checksum = raw.slice(raw.length - 4);

  const vpay = raw.slice(0, raw.length - 4);
  const h = sha256Bytes(sha256Bytes(vpay));
  const expected = h.slice(0, 4);
  if (!eqBytes(checksum, expected)) throw new Error('bad checksum');

  return { version, payload };
}

export function base58checkEncode(version: number, payload: Uint8Array): string {
  const head = new Uint8Array([version & 0xff]);
  const vpay = concatBytes(head, payload);
  const checksum = sha256Bytes(sha256Bytes(vpay)).slice(0, 4);
  return base58Encode(concatBytes(vpay, checksum));
}

export function pubkeyHash160(pubkeyHex: string): Uint8Array {
  return hash160Bytes(hexToBytes(pubkeyHex));
}

export function pubkeyToBase58P2pkh(pubkeyHex: string, versionByte: number): string {
  return base58checkEncode(versionByte, pubkeyHash160(pubkeyHex));
}

export function pubkeyMatchesBase58P2pkhAddress(pubkeyHex: string, address: string): boolean {
  try {
    const addr = String(address || '').trim();
    const { version, payload } = base58checkDecode(addr);
    const want = pubkeyHash160(pubkeyHex);
    if (!eqBytes(payload, want)) return false;
    // Also enforce version/encoding (prevents cross-network “same hash160” acceptance).
    return base58checkEncode(version, want) === addr;
  } catch {
    return false;
  }
}

export function hexHash160OfPubkey(pubkeyHex: string): string {
  return bytesToHex(pubkeyHash160(pubkeyHex));
}

