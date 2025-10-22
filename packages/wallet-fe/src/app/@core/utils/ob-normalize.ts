type SnapshotLike = {
  symbol?: string;
  bids?: Array<{ price?: number; amount?: number; visible_quantity?: number }>;
  asks?: Array<{ price?: number; amount?: number; visible_quantity?: number }>;
  timestamp?: number;
};

function isSnapshotLike(x: unknown): x is SnapshotLike {
  return !!x && typeof x === 'object' && !Array.isArray(x)
      && (Array.isArray((x as any).bids) || Array.isArray((x as any).asks));
}

export function wrangleObMessageInPlace<M extends Record<string, any>>(msg: M): M {
  if (!msg || typeof msg !== 'object') return msg;
  const anyMsg = msg as Record<string, any>;

  // 1) orders: parse if string
  if (typeof anyMsg.orders === 'string') {
    anyMsg.orders = parseMaybeJson<any[]>(anyMsg.orders, []);
  }

  // 2) snapshot → array conversion
  const maybeSnap = anyMsg.orders as unknown;
  if (isSnapshotLike(maybeSnap)) {
    const arr: Array<{ price: number; amount: number; side: 'BUY'|'SELL'; isBuy: boolean; props?: any }> = [];

    for (const b of maybeSnap.bids ?? []) {
      arr.push({ price: Number(b?.price ?? 0), amount: Number(b?.amount ?? b?.visible_quantity ?? 0), side: 'BUY', isBuy: true });
    }
    for (const a of maybeSnap.asks ?? []) {
      arr.push({ price: Number(a?.price ?? 0), amount: Number(a?.amount ?? a?.visible_quantity ?? 0), side: 'SELL', isBuy: false });
    }

    anyMsg.orders = arr; // so your Array.isArray path continues to work
    if (!anyMsg.marketKey && (maybeSnap as any).symbol) anyMsg.marketKey = (maybeSnap as any).symbol;
  }

  // 3) history: parse if string; coerce numbers (e.g. 0) to []
  if (typeof anyMsg.history === 'string') {
    anyMsg.history = parseMaybeJson<any[]>(anyMsg.history, []);
  } else if (typeof anyMsg.history === 'number') {
    anyMsg.history = [];
  }

  // 4) 🔧 ENRICH rows with props.id_for_sale / props.id_desired using marketKey "base-quote"
  //    This makes your existing _structureOrderbook() filter pass.
  const mk = typeof anyMsg.marketKey === 'string' ? anyMsg.marketKey : '';
  const m = /^\d+-\d+$/.test(mk) ? mk.split('-').map(n => Number(n)) : null;
  const baseId  = m ? m[0] : undefined; // first_token.propertyId
  const quoteId = m ? m[1] : undefined; // second_token.propertyId

  if (Array.isArray(anyMsg.orders) && baseId !== undefined && quoteId !== undefined) {
    for (const o of anyMsg.orders) {
      const isBuy = o?.isBuy === true || o?.side === 'BUY';
      const price = Number(o?.price ?? 0);
      const amount = Number(o?.amount ?? 0);
      o.props = o.props || {};
      // BUY: spend quote to buy base → id_for_sale = quoteId, id_desired = baseId
      // SELL: sell base for quote     → id_for_sale = baseId,  id_desired = quoteId
      o.props.id_for_sale = isBuy ? quoteId : baseId;
      o.props.id_desired  = isBuy ? baseId  : quoteId;
      o.props.price       = Number.isFinite(price)  ? price  : 0;
      o.props.amount      = Number.isFinite(amount) ? amount : 0;
    }
  }

  return msg;
}
// ===== helpers (same pattern as spot) =====
// NOTE: If you already define parseMaybeJson elsewhere, remove ONE of the duplicates.
function parseMaybeJson<T = any>(x: unknown, fallback: T): T {
  if (x == null) return fallback;
  if (typeof x !== 'string') return x as T;
  try { return JSON.parse(x) as T; } catch { return fallback; }
}

type FuturesSnapshotLike = {
  symbol?: string;
  bids?: Array<{ price?: number; amount?: number; visible_quantity?: number }>;
  asks?: Array<{ price?: number; amount?: number; visible_quantity?: number }>;
  timestamp?: number;
};

function isFuturesSnapshotLike(x: unknown): x is FuturesSnapshotLike {
  return !!x && typeof x === 'object' && !Array.isArray(x)
      && (Array.isArray((x as any).bids) || Array.isArray((x as any).asks));
}

// Normalize inbound market key for futures (e.g., "3" → "3-perp", keep "3-perp")
function normalizePerpMarketKey(x: unknown): string | undefined {
  if (!x) return undefined;
  let s = String(x).trim();
  if (!s) return undefined;
  s = s.toLowerCase();

  // Accept "3", "3-perp", "3-PERP", "3-futures"
  if (/^\d+$/.test(s)) return `${s}-perp`;
  if (/^\d+-(?:perp|futures)$/.test(s)) return s.replace(/-futures$/, '-perp');

  // tolerate aliases: e.g. "marketKey: 3"
  const m = s.match(/^(\d+)(?:-(?:perp|futures))?$/);
  if (m) return `${m[1]}-perp`;

  return s;
}

// Local structural type (avoids importing IFuturesOrder here)
type FuturesRow = {
  action: 'SELL' | 'BUY';
  keypair: { address: string; pubkey: string };
  lock: boolean;
  props: {
    amount: number;
    contract_id: number;
    price: number;
    leverage: 10;
    collateral: number;
  };
  socket_id: string;
  timestamp: number;
  type: 'FUTURES';
  uuid: string;
};

export function wrangleFuturesObMessageInPlace<M extends Record<string, any>>(msg: M): M {
  if (!msg || typeof msg !== 'object') return msg;
  const anyMsg = msg as Record<string, any>;

  // 0) derive a perp marketKey ASAP (even if orders is already array)
  const sym0 = anyMsg.symbol ?? anyMsg.market ?? anyMsg.marketKey ?? anyMsg?.orders?.symbol;
  const mk0 = normalizePerpMarketKey(sym0);
  if (mk0) anyMsg.marketKey = mk0;

  // 1) orders: parse if string
  if (typeof anyMsg.orders === 'string') {
    anyMsg.orders = parseMaybeJson<any[]>(anyMsg.orders, []);
  }

  // 2) snapshot → array conversion
  const snap = anyMsg.orders as unknown;
  if (isFuturesSnapshotLike(snap)) {
    const arr: FuturesRow[] = [];
    const ts = Number((snap as any).timestamp) || Date.now();

    // prefer fresh normalization from snapshot.symbol
    const sym = (snap as any).symbol ?? sym0;
    const mk = normalizePerpMarketKey(sym) ?? mk0;
    if (mk) anyMsg.marketKey = mk;

    // contract_id: take leading number from marketKey (e.g., "3-perp" -> 3)
    const contractId = (mk && /^\d+/.test(mk)) ? Number(mk.match(/^\d+/)![0]) : 0;

    const mapRow = (row: any, action: 'BUY' | 'SELL', i: number): FuturesRow => ({
      action,
      keypair: { address: '', pubkey: '' },
      lock: false,
      props: {
        amount: Number(row?.amount ?? row?.visible_quantity ?? 0),
        contract_id: contractId,
        price: Number(row?.price ?? 0),
        leverage: 10,
        collateral: 0,
      },
      socket_id: '',
      timestamp: ts + i,
      type: 'FUTURES',
      uuid: `${action === 'BUY' ? 'bid' : 'ask'}-${i}-${ts}`
    });

    for (let i = 0; i < (snap.bids?.length ?? 0); i++) arr.push(mapRow(snap.bids![i], 'BUY', i));
    for (let j = 0; j < (snap.asks?.length ?? 0); j++) arr.push(mapRow(snap.asks![j], 'SELL', j));

    // Keep it untyped here; service can cast as IFuturesOrder[] where needed
    anyMsg.orders = arr;
  }

  // 3) history → []
  if (typeof anyMsg.history === 'string') {
    anyMsg.history = parseMaybeJson<any[]>(anyMsg.history, []);
  } else if (typeof anyMsg.history === 'number') {
    anyMsg.history = [];
  }

  // 4) if orders already array (no snapshot), still backfill marketKey if missing
  if (!anyMsg.marketKey) {
    const sym2 = anyMsg.symbol ?? anyMsg.market ?? anyMsg?.orders?.symbol;
    const mk2 = normalizePerpMarketKey(sym2);
    if (mk2) anyMsg.marketKey = mk2;
  }

  return msg;
}
