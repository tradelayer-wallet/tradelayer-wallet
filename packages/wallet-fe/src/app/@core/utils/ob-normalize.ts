// Minimal, dependency-free helpers for orders & orderbook payloads

// ---- parsing ----
export function parseMaybeJson<T = any>(x: any, fallback: T): T {
  try {
    if (x == null) return fallback;
    if (typeof x === 'string') return JSON.parse(x) as T;
    return x as T;
  } catch {
    return fallback;
  }
}

// ---- symbol typing & scaling ----
export type Desk = 'SPOT' | 'FUTURES';

export function classifySymbol(sym: string): Desk | 'UNKNOWN' {
  if (!sym) return 'UNKNOWN';
  if (/^\d+-\d+$/.test(sym)) return 'SPOT';        // e.g. "0-5"
  if (/^\d+$/.test(sym)) return 'FUTURES';         // e.g. "5"
  if ((sym.match(/-/g) || []).length >= 2) return 'FUTURES';
  if (/-FUT\b/i.test(sym)) return 'FUTURES';
  if (/(?:^|-)C(?:-|$)/i.test(sym) || /(?:^|-)P(?:-|$)/i.test(sym)) return 'FUTURES';
  return 'UNKNOWN';
}
export const isSpotSymbol    = (s: string) => classifySymbol(s) === 'SPOT';
export const isFuturesSymbol = (s: string) => classifySymbol(s) === 'FUTURES';

/**
 * Per-market price scale (engine ticks -> UI units).
 * TODO: replace with real market metadata when available.
 */
export function priceScaleForSymbol(symbol?: string): number {
  if (!symbol) return 1;
  // Example: TLTC/USDTt spot uses cent-based ticks in engine => 100
  if (symbol === '0-5') return 100;
  return 1; // default 1:1
}

// ---- legacy mappers for UI tables ----
export interface LegacyOpenRow {
  uuid: string;
  engine_id?: string;
  price: string;      // legacy (top-level)
  amount: string;     // legacy (top-level)
  side: 'BUY' | 'SELL';
  marketKey: string;
  timestamp: number;
  type: Desk;
  state: 'OPEN';
  keypair?: any;

  // fields actually bound by the templates
  action: 'BUY' | 'SELL';
  marketName: string;
  props: { amount: string; price: string };
}

export interface LegacyHistRow {
  uuid: string;
  marketKey: string;
  side: 'BUY' | 'SELL';
  timestamp: number;
  action: 'BUY' | 'SELL';
  state: string; // SUBMIT_ACK | RESTED | MATCH | FILLED | ...
  props: { amount: string; price: string };
  type: Desk;
  keypair?: any;
}

export function toLegacyOpen(
  o: any,
  desk: Desk,
  keypair: any,
  marketName?: string
): LegacyOpenRow {
  const scale = priceScaleForSymbol(o?.symbol);
  const price = Number(o?.price ?? 0) / scale;

  return {
    uuid:       String(o?.uuid ?? ''),
    engine_id:  o?.engine_id,
    price:      String(price),
    amount:     String(o?.amount ?? 0),
    side:       o?.side ?? 'BUY',
    marketKey:  String(o?.symbol ?? ''),
    timestamp:  Number(o?.timestamp ?? Date.now()),
    type:       desk,
    state:      'OPEN',
    keypair,

    action:     o?.side ?? 'BUY',
    marketName: marketName ?? (o?.marketName ?? o?.symbol ?? '-'),
    props: {
      amount: String(o?.amount ?? 0),
      price:  String(price),
    },
  };
}

export function toLegacyHist(
  e: any,
  desk: Desk,
  keypair: any
): LegacyHistRow {
  const scale = priceScaleForSymbol(e?.symbol);
  const qty   = e?.qty ?? e?.quantity ?? e?.resting_qty ?? 0;
  const price = Number(e?.price ?? 0) / scale;

  return {
    uuid:       String(e?.uuid ?? ''),
    marketKey:  String(e?.symbol ?? ''),
    side:       e?.side ?? 'BUY',
    timestamp:  Number(e?.ts ?? e?.timestamp ?? Date.now()),
    action:     e?.side ?? 'BUY',
    state:      String(e?.event ?? ''),
    props: {
      amount: String(qty),
      price:  String(price),
    },
    type:       desk,
    keypair,
  };
}

// ---- normalize placed-orders payloads (arrays or JSON strings) ----
export function normalizeOpenedOrders(
  openedRaw: any,
  desk: Desk,
  keypair: any
): LegacyOpenRow[] {
  const list = parseMaybeJson<any[]>(openedRaw, []);
  return list.map(o => toLegacyOpen(o, desk, keypair));
}

export function normalizeOrderHistory(
  histRaw: any,
  desk: Desk,
  keypair: any
): LegacyHistRow[] {
  const list = parseMaybeJson<any[]>(histRaw, []);
  return list.map(e => toLegacyHist(e, desk, keypair));
}

// ---- orderbook snapshot (engine -> UI) ----
export interface NormalizedL2 {
  symbol: string;
  timestamp: number;
  bids: Array<{ price: number; amount: number; count: number }>;
  asks: Array<{ price: number; amount: number; count: number }>;
  checksum?: string;
}

export function normalizeSnapshot(snapRaw: any): NormalizedL2 | null {
  const snapObj = parseMaybeJson<any>(snapRaw, null);
  if (!snapObj || !snapObj.snapshot) return null;

  const sym   = String(snapObj.snapshot.symbol ?? '');
  const scale = priceScaleForSymbol(sym);

  const mapSide = (rows: any[] = []) =>
    rows.map(r => ({
      price:  scale ? Number(r?.price ?? 0) / scale : Number(r?.price ?? 0),
      amount: Number(r?.visible_quantity ?? 0),
      count:  Number(r?.order_count ?? 0),
    }));

  return {
    symbol:    sym,
    timestamp: Number(snapObj.snapshot.timestamp ?? Date.now()),
    bids:      mapSide(snapObj.snapshot.bids),
    asks:      mapSide(snapObj.snapshot.asks),
    checksum:  snapObj.checksum,
  };
}
