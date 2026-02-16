import type { TapeEntryV1 } from '../types';

export type TapeReplayEvent =
  | { t: 'NEW'; orderId: string; market: string; side: 'BUY' | 'SELL'; px: string; qty: string }
  | { t: 'CANCEL'; orderId: string }
  | { t: 'REPLACE'; oldOrderId: string; newOrderId: string };

// MVP: convert a verified tape entry into a normalized event that the UI can feed into a shadow book.
export function replayEntry(entry: TapeEntryV1): TapeReplayEvent | null {
  const o = entry.order;
  if (o.v !== 1) return null;
  if (o.kind === 'NEW') {
    return {
      t: 'NEW',
      orderId: o.orderId,
      market: o.body.market,
      side: o.body.side,
      px: o.body.px,
      qty: o.body.qty,
    };
  }
  if (o.kind === 'CANCEL') {
    const id = o.cancelsOrderId || o.orderId;
    return { t: 'CANCEL', orderId: id };
  }
  if (o.kind === 'REPLACE') {
    if (!o.replacesOrderId) return null;
    return { t: 'REPLACE', oldOrderId: o.replacesOrderId, newOrderId: o.orderId };
  }
  return null;
}

