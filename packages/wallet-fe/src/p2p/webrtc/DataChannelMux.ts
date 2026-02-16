import type { WireMsg } from '../types';

type Handler = (msg: WireMsg) => void;

export class DataChannelMux {
  private dc: RTCDataChannel;
  private handlers: Set<Handler> = new Set();

  constructor(dc: RTCDataChannel) {
    this.dc = dc;
    this.dc.binaryType = 'arraybuffer';

    this.dc.onmessage = (ev) => {
      try {
        const data = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
        const msg = JSON.parse(data) as WireMsg;
        for (const h of this.handlers) h(msg);
      } catch {
        // Ignore malformed messages; caller may add observability later.
      }
    };
  }

  onMessage(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  send(msg: WireMsg) {
    const s = JSON.stringify(msg);
    this.dc.send(s);
  }

  isOpen(): boolean {
    return this.dc.readyState === 'open';
  }

  close() {
    try {
      this.dc.close();
    } catch {}
  }
}

