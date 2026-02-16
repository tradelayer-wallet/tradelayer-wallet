import type { OrderEnvelopeV1, TapeEntryV1 } from './types';

export interface PeerTransportStatus {
  mode: 'P2P';
  connected: boolean;
  peerId?: string;
  collatorUrl?: string;
  rttMs?: number;
  lastPongAtMs?: number;
  usingRelay?: boolean;
}

export interface PeerTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;

  submit(order: OrderEnvelopeV1): Promise<void>;
  subscribeTape(cb: (entry: TapeEntryV1) => void): () => void;

  getStatus(): PeerTransportStatus;
}
