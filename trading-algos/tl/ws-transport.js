/* ws-transport.js — pure WS, spam-safe, parity-preserving */
'use strict';

const { EventEmitter } = require('events');
const WS = (typeof WebSocket !== 'undefined') ? WebSocket : require('ws');

/* -------- OUTBOUND FILTERS ---------- */
/* Local-only events your app used to keep off the wire. 
   (Expanded minimally to match prior behavior and your notes.) */
const OUTBOUND_BLOCKLIST = new Set([
  // lifecycle / diagnostics
  'connected', 'connect', 'disconnect', 'reconnect', 'message', 'error', 'ws-error',
  // local bus/order lifecycle
  'order:saved', 'order:error', 'placed-orders', 'orders:placed',
  // misc keepalives
  'ping', 'pong'
]);

/* Only these go to server by default. */
const SERVER_EVENTS = new Set([
  'new-order',
  'update-orderbook',
  'close-order',
  'many-orders',
  'disconnect',
  'orderbook:join',
  'orderbook:leave'
]);

/* Auto-once these inbound events to prevent per-request leaks (unless handler.persist=true) */
const AUTO_ONCE_EVENTS = new Set(['order:saved', 'order:error']);

/* ------------------------------------ */

function _emitLocal(em, ev, payload) {
  try { EventEmitter.prototype.emit.call(em, ev, payload); } catch {}
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

class WsTransport extends EventEmitter {
  /**
   * @param {string|object} arg  url or { url, headers?, pingMs? }
   * @param {object} [opts]
   */
  constructor(arg, opts = {}) {
    super();
    const cfg = (typeof arg === 'string') ? { url: arg, ...opts } : (arg || {});
    this.url = cfg.url || null;
    this.opts = { headers: cfg.headers, pingMs: cfg.pingMs || 0 };

    /** @type {WebSocket|null} */
    this.ws = null;

    // Prevent duplicate inbound bridges and track listener identity
    this._bridgeBound = false;
    this._listenerSet = new Map(); // event -> Set<fn or fn.__orig>

    this.setMaxListeners(0); // allow many, we’ll handle cleanup ourselves
  }

  /* ---- listener anti-spam layer ---- */
  on(event, handler)  { return this._dedupAdd(event, handler, false); }
  addListener(event, handler) { return this._dedupAdd(event, handler, false); }
  once(event, handler){ return this._dedupAdd(event, handler, true); }

  // Replace existing off(...) in ws-transport.js with this:
  off(event, handler) {
    // If no event, nothing to do
    if (!event || typeof event !== 'string') return this;

    const set = this._listenerSet?.get?.(event);

    // Case 1: remove all listeners for this event when no handler provided
    if (handler == null) {
      if (set && set.size) {
        for (const fn of Array.from(set)) {
          const orig = fn.__orig || fn;
          if (typeof orig === 'function') {
            try { this.removeListener?.(event, orig); } catch {}
          }
        }
        set.clear();
      }
      this._listenerSet?.delete?.(event);
      return this;
    }

    // Case 2: handler provided but not a function → no-op (avoid Node ERR_INVALID_ARG_TYPE)
    const orig = handler.__orig || handler;
    if (typeof orig !== 'function') {
      // also clean bookkeeping if present
      if (set) {
        set.delete(handler);
        set.delete(orig);
        if (!set.size) this._listenerSet.delete(event);
      }
      return this;
    }

    // Normal path: remove the specific handler
    try { this.removeListener?.(event, orig); } catch {}
    if (set) {
      set.delete(handler);
      set.delete(orig);
      if (!set.size) this._listenerSet.delete(event);
    }
    return this;
  }

  removeListener(event, handler) { return this.off(event, handler); }

  _dedupAdd(event, handler, forceOnce) {
    // If auto-once target and handler not marked persistent, wrap it
    let fn = handler;
    const shouldOnce = forceOnce || (AUTO_ONCE_EVENTS.has(event) && !handler?.persist);
    if (shouldOnce) {
      const wrapped = (...args) => { this.off(event, wrapped); handler(...args); };
      Object.defineProperty(wrapped, '__orig', { value: handler });
      fn = wrapped;
    }

    // De-duplicate by original function identity
    const key = fn.__orig || fn;
    const set = this._listenerSet.get(event) || new Set();
    if (set.has(key)) return this; // already attached
    set.add(key); this._listenerSet.set(event, set);

    return EventEmitter.prototype.on.call(this, event, fn);
  }

  /* ---- connection ---- */

  /**
   * Connects to WebSocket. If url omitted, uses ctor url.
   * Resolves on 'open', rejects on error/close before open.
   */
  connect(url) {
    const target = url || this.url;
    if (!target) return Promise.reject(new Error('WebSocket URL not provided'));

    // Already open?
    if (this.ws && this.ws.readyState === (WS.OPEN || 1)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        const ws = (typeof window === 'undefined')
          ? new WS(target, { headers: this.opts.headers })
          : new WS(target);

        this.ws = ws;
        this._bridgeBound = false;

        const handleMessage = (raw) => {
          // --- normalize inbound raw/text ---
          const txt =
            typeof raw === 'string'
              ? raw
              : (raw?.data != null
                  ? (typeof raw.data === 'string' ? raw.data : raw.data.toString())
                  : raw?.toString?.());
          if (!txt) return;

          const frame = safeParse(txt);
          if (!frame || typeof frame.event !== 'string') return;

          const ev = frame.event;
          // Use 'data' if provided; otherwise pass the whole frame
          let norm = (frame.data !== undefined ? frame.data : frame);

          // --- restore legacy behavior for <socketId>::swap frames ---
          // Server sends: { event: "<id>::swap", data: { eventName, socketId, data } }
          // Older FE flattened one nesting level when payload itself contained a { data: {...} } object.
          if (ev.endsWith('::swap')) {
            if (
              norm && typeof norm === 'object' &&
              'data' in norm && typeof norm.data === 'object' &&
              norm.eventName === undefined && norm.socketId === undefined
            ) {
              const inner = norm.data;            // { eventName, socketId, data }
              norm = { ...norm, ...inner };       // flatten one level
            }
          }

          // Emit normalized payload to the exact event listeners
          _emitLocal(this, ev, norm);

          // Also emit generic 'message' tap with { event, data } for logging/metrics
          _emitLocal(this, 'message', { event: ev, data: norm });

          // After resolving order:saved / order:error, sweep any non-persistent leftovers
          if (AUTO_ONCE_EVENTS.has(ev)) {
            const set = this._listenerSet.get(ev);
            if (set && set.size) {
              for (const fn of Array.from(set)) {
                const orig = fn.__orig || fn;
                if (!orig?.persist) this.off(ev, fn);
              }
            }
          }
        };


        ws.onopen = () => {
          this._bindBridgeOnce(ws, handleMessage);
          console.log('[WS] connected to', target);
          if (!settled) { settled = true; resolve(); }
          _emitLocal(this, 'connected', { url: target });
          _emitLocal(this, 'connect',   { url: target });
        };

        ws.onmessage = handleMessage;
        if (typeof ws.on === 'function') ws.on('message', (buf) => handleMessage(buf));

        ws.onerror = (e) => {
          const err = e?.error instanceof Error ? e.error : new Error(e?.message || 'ws error');
          console.error('[WS] error', err);
          _emitLocal(this, 'ws-error', err);
          if (!settled && ws.readyState !== (WS.OPEN || 1)) { settled = true; reject(err); }
        };

        ws.onclose = (ev) => {
          console.warn('[WS] closed');
          this._bridgeBound = false;
          // don’t nuke _listenerSet here; we only clean non-persistent on event fire
          _emitLocal(this, 'disconnect', { code: ev?.code, reason: ev?.reason });
          if (!settled) { settled = true; reject(new Error(`closed before open (${ev?.code || ''})`)); }
        };
      } catch (e) {
        console.error('[WS] create error', e);
        reject(e);
      }
    });
  }

  _bindBridgeOnce(ws, /* message fn already bound */) {
    if (this._bridgeBound) return;
    this._bridgeBound = true;
  }

  close(code = 1000, reason = 'client-close') { try { this.ws?.close(code, reason); } catch {} return this; }
  disconnect(code, reason) { return this.close(code, reason); }
  get isOpen() { return !!this.ws && this.ws.readyState === (WS.OPEN || 1); }

  /**
   * Transport.emit:
   * - keeps local-only events off the wire (OUTBOUND_BLOCKLIST)
   * - only whitelisted server events are sent
   * - everything else is local re-emit (no extra spam to server)
   */
    emit(event, payload = {}) {
    // local-only events
    if (OUTBOUND_BLOCKLIST.has(event)) {
      _emitLocal(this, event, payload);
      return this;
    }

    // allow dynamic namespaced swap events to go upstream
    const isServerEvent =
      SERVER_EVENTS.has(event) ||
      (typeof event === 'string' && event.endsWith('::swap'));

    if (!isServerEvent) {
      _emitLocal(this, event, payload);
      return this;
    }

    // send upstream
    if (!this.ws || this.ws.readyState !== 1) {
      _emitLocal(this, 'ws-drain', { event, payload });
      return this;
    }

    // NOTE: server expects top-level merge, not { data: payload }
    const frame = Object.assign({ event }, payload || {});
    try { this.ws.send(JSON.stringify(frame)); }
    catch (e) { _emitLocal(this, 'ws-error', e); }

    return this;
  }
}

/* Factory kept for parity with your callers */
function createTransport(opts) {
  // callers do createTransport({ type:'ws', url: 'ws://...' })
  const url = (opts && typeof opts === 'object') ? opts.url : opts;
  return new WsTransport(url || null, opts || {});
}

module.exports = {
  WsTransport,
  createTransport,
  OUTBOUND_BLOCKLIST,
  create: createTransport
};
module.exports.default = {
  WsTransport,
  createTransport,
  OUTBOUND_BLOCKLIST,
  create: createTransport
};
