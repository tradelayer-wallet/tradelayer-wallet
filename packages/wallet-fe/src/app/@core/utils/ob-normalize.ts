function parseMaybeJson<T = any>(x: unknown, fallback: T): T {
  if (x == null) return fallback;
  if (typeof x !== 'string') return x as T;
  try {
    return JSON.parse(x) as T;
  } catch {
    return fallback;
  }
}


type SnapshotLike = {
  symbol?: string;
  bids?: Array<{ price?: number; amount?: number; visible_quantity?: number }>;
  asks?: Array<{ price?: number; amount?: number; visible_quantity?: number }>;
  timestamp?: number;
};

function isSnapshotLike(x: unknown): x is SnapshotLike {
  return !!x
    && typeof x === 'object'
    && !Array.isArray(x)
    && (Array.isArray((x as any).bids) || Array.isArray((x as any).asks));
}

export function wrangleObMessageInPlace<M extends Record<string, any>>(msg: M): M {
  if (!msg || typeof msg !== 'object') return msg;

  const anyMsg = msg as Record<string, any>;

  // orders: parse if string
  if (typeof anyMsg.orders === 'string') {
    anyMsg.orders = parseMaybeJson<any[]>(anyMsg.orders, []);
  }

  // snapshot → array conversion
  const maybeSnap = anyMsg.orders as unknown;
  if (isSnapshotLike(maybeSnap)) {
    const arr: Array<{ price: number; amount: number; side: 'BUY' | 'SELL'; isBuy: boolean }> = [];

    for (const b of maybeSnap.bids ?? []) {
      arr.push({
        price: Number(b?.price ?? 0),
        amount: Number(b?.amount ?? b?.visible_quantity ?? 0),
        side: 'BUY',
        isBuy: true,
      });
    }
    for (const a of maybeSnap.asks ?? []) {
      arr.push({
        price: Number(a?.price ?? 0),
        amount: Number(a?.amount ?? a?.visible_quantity ?? 0),
        side: 'SELL',
        isBuy: false,
      });
    }

    anyMsg.orders = arr; // so your Array.isArray path runs as-is
    if (!anyMsg.marketKey && maybeSnap.symbol) anyMsg.marketKey = maybeSnap.symbol;
  }

  // history: parse if string; coerce numbers (e.g. 0) to []
  if (typeof anyMsg.history === 'string') {
    anyMsg.history = parseMaybeJson<any[]>(anyMsg.history, []);
  } else if (typeof anyMsg.history === 'number') {
    anyMsg.history = [];
  }

  // best-effort numeric coercions for lastTrade.props
  if (Array.isArray(anyMsg.history) && anyMsg.history.length > 0) {
    const lt = anyMsg.history[0];
    if (lt && typeof lt === 'object' && lt.props && typeof lt.props === 'object') {
      const toNum = (x: any) => {
        const v = Number(x);
        return Number.isNaN(v) ? x : v;
        };
      lt.props.price         = toNum(lt.props.price);
      lt.props.amountForSale = toNum(lt.props.amountForSale);
      lt.props.amountDesired = toNum(lt.props.amountDesired);
    }
  }

  return msg;
}
