// Maps a TradeLayer market onto a BitcornWisdom instrument id (the explicit allowlist of its
// feed policy; see the bitcorn patches in overlay.json for the LTC entries added to it).
// Pure functions, erasable TypeScript only: scripts/test-bitcorn-instrument.mjs runs them under Node.

export type ChartKind = 'spot' | 'futures';

export interface MarketRef {
  kind: ChartKind;
  /** first token of the pair, as the orderbook server names it (BTC, LTC, TL, TLTC, sLTCt, ...) */
  base: string;
  /** second token (USDT, USDTt, LTC, BTC, ...) */
  quote: string;
}

export interface InstrumentPlan {
  state: 'chart' | 'none';
  /** BitcornWisdom instrument id to mount, null in the "none" state */
  instrument: string | null;
  /** spot instrument to switch to when `instrument` (a perpetual) has no reachable source */
  fallback: string | null;
  /** short label for the card header, e.g. "LTC / USD · spot" */
  label: string;
  /** shown on the chart when the chart is not the market's own price, '' otherwise */
  note: string;
}

/** assets with an external USD price in BitcornWisdom's instrument set (LTC is added by the bundle patch) */
export const SPOT_USD = ['BTC', 'ETH', 'LTC'];
/** assets with a USDT perpetual (Binance USDⓈ-M) */
export const PERPETUAL = ['BTC', 'LTC'];
const USD_LIKE = ['USD', 'USDT', 'USDH', 'TLUSD', 'USDC'];

/**
 * Canonical ticker of a TradeLayer token short name:
 * TLTC -> LTC, sLTC / sLTCt -> LTC, sBTC -> BTC, USDTt -> USDT, TLt -> TL, XBT -> BTC.
 */
export function canon(raw: string | null | undefined): string {
  let v = (raw || '').trim();
  if (v === 'TLTC') return 'LTC';
  if (v === 'TBTC') return 'BTC';
  if (/^s[A-Z]/.test(v)) v = v.slice(1);
  if (/^[A-Z]{2,}t$/.test(v)) v = v.slice(0, -1);
  v = v.toUpperCase();
  return v === 'XBT' ? 'BTC' : v;
}

const none = (label: string, note: string): InstrumentPlan => ({ state: 'none', instrument: null, fallback: null, label, note });

export function planInstrument(m: MarketRef): InstrumentPlan {
  const base = canon(m.base);
  const quote = canon(m.quote);
  const pair = `${m.base || '?'} / ${m.quote || '?'}`;
  if (!base || !quote) return none(pair, 'No market selected.');
  const quoteUsd = USD_LIKE.includes(quote);

  // the market's own asset has an external price
  if (SPOT_USD.includes(base) && quoteUsd) {
    if (m.kind === 'futures' && PERPETUAL.includes(base)) {
      return { state: 'chart', instrument: `${base}-USDT-PERP`, fallback: `${base}-USD-SPOT`, label: `${base} / USDT · perpetual`, note: '' };
    }
    return { state: 'chart', instrument: `${base}-USD-SPOT`, fallback: null, label: `${base} / USD · spot`, note: '' };
  }
  // an external asset against another external asset (LTC/BTC): no cross feed, chart the base in USD
  if (SPOT_USD.includes(base) && SPOT_USD.includes(quote) && base !== quote) {
    return { state: 'chart', instrument: `${base}-USD-SPOT`, fallback: null, label: `${base} / USD · spot`,
      note: `No ${base}/${quote} feed; showing ${base} / USD.` };
  }
  // a TradeLayer-native or synthetic asset priced in an external one (TL/LTC): chart the collateral asset
  if (SPOT_USD.includes(quote) && !SPOT_USD.includes(base)) {
    return { state: 'chart', instrument: `${quote}-USD-SPOT`, fallback: null, label: `${quote} / USD · spot`,
      note: `${m.base} has no external market; showing the collateral asset ${quote} / USD.` };
  }
  return none(pair, `${m.base} has no external market, so there is no exchange chart for ${pair}.`);
}
