function parseMaybeJson<T = any>(x: unknown, fallback: T): T {
  if (x == null) return fallback;
  if (typeof x !== 'string') return x as T;
  try { return JSON.parse(x) as T; } catch { return fallback; }
}

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
