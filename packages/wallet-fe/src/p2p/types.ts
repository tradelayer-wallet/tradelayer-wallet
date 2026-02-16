export type Hex = string;

export type Visibility =
  | { kind: 'PUBLIC' }
  | { kind: 'CLEARLIST'; groupId: string }
  | { kind: 'DARK'; groupId: string };

export interface OrderBodyV1 {
  v: 1;
  market: string;
  side: 'BUY' | 'SELL';
  px: string; // decimal string
  qty: string; // decimal string
  tif?: 'GTC' | 'IOC' | 'FOK';
  expiryTs?: number; // unix ms
  visibility: Visibility;
  clearlistTag?: string;
  clientTs: number; // unix ms
}

export interface OrderEnvelopeV1 {
  v: 1;
  kind: 'NEW' | 'CANCEL' | 'REPLACE';
  body: OrderBodyV1;
  traderPubKey: Hex;
  clientNonce: Hex; // 16-32 bytes hex
  orderId: Hex; // sha256(canonical(body)+pubkey+nonce)
  sigTrader: Hex; // sig(orderId)
  replacesOrderId?: Hex;
  cancelsOrderId?: Hex;
}

export interface TapeEntryV1 {
  v: 1;
  collatorId: string;
  seq: number;
  prevHash: Hex;
  entryHash: Hex;
  receivedTs: number;
  order: OrderEnvelopeV1;
  sigCollator: Hex;
}

export type WireMsg =
  | { t: 'HELLO'; v: 1; clientId: string; want: Array<'TAPE' | 'SUBMIT'> }
  | { t: 'SUBMIT'; v: 1; order: OrderEnvelopeV1 }
  | { t: 'TAPE_SUB'; v: 1; fromSeq?: number }
  | { t: 'TAPE_ENTRY'; v: 1; entry: TapeEntryV1 }
  | { t: 'PING'; v: 1; ts: number }
  | { t: 'PONG'; v: 1; ts: number }
  | { t: 'ERR'; v: 1; code: string; msg: string };

