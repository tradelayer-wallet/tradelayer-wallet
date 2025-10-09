// === add to src/app/@core/utils/ob-normalize.ts ===
export interface NormalizedL2 {
  symbol: string;
  timestamp: number;
  bids: Array<{ price: number; amount: number; count: number }>;
  asks: Array<{ price: number; amount: number; count: number }>;
  checksum?: string;
}

// If you don't already have these in the file, include them:
export function parseMaybeJson<T = any>(x: any, fallback: T): T {
  try {
    if (x == null) return fallback;
    if (typeof x === 'string') return JSON.parse(x) as T;
    return x as T;
  } catch {
    return fallback;
  }
}

export function priceScaleForSymbol(symbol?: string): number {
  if (!symbol) return 1;
  if (symbol === '0-5') return 100; // example; replace with your metadata
  return 1;
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

/**
 * Mutates `msg` in-place so your existing listener code can run unchanged:
 * - Ensures msg.orders is an array (or [] if a snapshot was provided)
 * - Parses stringified orders/history
 * - Attaches normalized snapshot at msg._normSnapshot when provided
 * - Sets msg.marketKey from snapshot.symbol if absent
 * - Coerces lastTrade.props.price to a number if possible
 */
export function wrangleObMessageInPlace<T extends any>(msg: T): T {
  if (!msg || typeof msg !== 'object') return msg as T;

  // 1) orders: parse if string
  // @ts-expect-error dynamic shape
  if (typeof msg.orders === 'string') {
    // @ts-expect-error dynamic shape
    msg.orders = parseMaybeJson<any[]>(msg.orders, []);
  }

  // 2) if orders isn't an array, see if it's a snapshot; if so, normalize & stash
  let snap: NormalizedL2 | null = null;
  // @ts-expect-error dynamic shape
  if (!Array.isArray(msg.orders) && (msg as any).orders != null) {
    // @ts-expect-error dynamic shape
    snap = normalizeSnapshot(msg.orders);
    if (snap) {
      (msg as any)._normSnapshot = snap;                 // stash normalized snapshot
      if (!(msg as any).marketKey && snap.symbol) (msg as any).marketKey = snap.symbol;
      // @ts-expect-error dynamic shape
      msg.orders = [];                                    // keep your array-based path intact
    }
  }

  // 3) history: parse if string
  // @ts-expect-error dynamic shape
  if (typeof msg.history === 'string') {
    // @ts-expect-error dynamic shape
    msg.history = parseMaybeJson<any[]>(msg.history, []);
  }

  // 4) make lastTrade.props.* numeric if possible
  // @ts-expect-error dynamic shape
  if (Array.isArray(msg.history) && (msg.history as any[]).length > 0) {
    // @ts-expect-error dynamic shape
    const lt = (msg.history as any[])[0];
    const hasProps = lt && typeof lt === 'object' && lt.props && typeof lt.props === 'object';
    if (hasProps) {
      const p   = Number(lt.props.price);
      const afs = Number(lt.props.amountForSale);
      const ad  = Number(lt.props.amountDesired);
      if (!Number.isNaN(p))   lt.props.price = p;
      if (!Number.isNaN(afs)) lt.props.amountForSale = afs;
      if (!Number.isNaN(ad))  lt.props.amountDesired = ad;
    }
  }

  // 5) if still no marketKey, salvage from snapshot or first order
  if (!(msg as any).marketKey) {
    if (snap?.symbol) (msg as any).marketKey = snap.symbol;
    // @ts-expect-error dynamic shape
    else if (Array.isArray(msg.orders) && (msg.orders as any[])[0]?.symbol) {
      // @ts-expect-error dynamic shape
      (msg as any).marketKey = (msg.orders as any[])[0].symbol;
    }
  }

  return msg;
}

