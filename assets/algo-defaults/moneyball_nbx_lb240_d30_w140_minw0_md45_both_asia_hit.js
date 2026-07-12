'use strict';

/* @algo
{
  "description": "Individual Moneyball sleeve from No-BTC sideways range-cross.",
  "mode": "FUTURES",
  "name": "Moneyball nbx_lb240_d30_w140_minw0_md45_both_asia_hit",
  "parameters": {
    "family": "no_btc_sideways_range_cross",
    "metrics": {
      "ev": 1.333004,
      "max_drawdown": 8.746104,
      "months": 36,
      "net": 69.316188,
      "p95_mae_bps": 17.18171,
      "positive_months": 25,
      "trades": 52,
      "worst_month": -5.877008
    },
    "status": "adapter_parity_validated"
  },
  "risk": {
    "liveExecution": false,
    "note": "Packaged read-only manifest bridge. Enable live execution only after adapter parity and sizing approval."
  },
  "symbol": "ETH/USD",
  "tags": [
    "moneyball",
    "no_btc_sideways_range_cross",
    "adapter_parity_validated"
  ],
  "timeframe": "portfolio",
  "venue": "TradeLayer/Lighter",
  "version": "2026-05-06"
}
@algo */

const SYSTEM = {
  "assumptions": {
    "execution_note": "Desktop wiring is read-only portfolio/strategy state. Live order routing must be separately approved and size-gated.",
    "lighter_fee_bps_per_side": 0.2,
    "tradelayer_fee_bps": 0.5,
    "tradelayer_mm_rebate_bps": 0.25
  },
  "family": "no_btc_sideways_range_cross",
  "id": "nbx_lb240_d30_w140_minw0_md45_both_asia_hit",
  "market": "ETH/USD",
  "metrics": {
    "ev": 1.333004,
    "max_drawdown": 8.746104,
    "months": 36,
    "net": 69.316188,
    "p95_mae_bps": 17.18171,
    "positive_months": 25,
    "trades": 52,
    "worst_month": -5.877008
  },
  "mode": "individual_sleeve",
  "spec": {
    "cooldown_sec": 0,
    "fixed_stop_bps": 30.0,
    "max_hold_sec": 300,
    "range_cross_fee_bps_per_side": 0.2,
    "range_cross_max_drift_frac": 0.3,
    "range_cross_max_mid_dist_frac": 0.45,
    "range_cross_max_width_bps": 140.0,
    "range_cross_min_width_bps": 0.0,
    "range_cross_regime_lookback": 240,
    "range_cross_session": "asia",
    "range_cross_signal_tf": "1m",
    "session_end_hour_utc": null,
    "session_start_hour_utc": null,
    "side_mode": "BOTH",
    "stop_type": "trailing",
    "strategy_id": "nbx_lb240_d30_w140_minw0_md45_both_asia_hit",
    "strategy_type": "sideways_range_cross",
    "trail_pct_bps": 15.0,
    "trail_timeframe": "1m"
  },
  "spec_path": "portfolio_candidates/no_btc_range_cross_adapter_specs/nbx_lb240_d30_w140_minw0_md45_both_asia_hit.json",
  "status": "adapter_parity_validated"
};

const startedAt = new Date().toISOString();
const size = Number(process.env.SIZE || process.env.QTY || process.env.TARGET_EXPOSURE || 0);

console.log('[moneyball] loaded', {
  id: SYSTEM.id,
  family: SYSTEM.family,
  mode: SYSTEM.mode,
  market: SYSTEM.market,
  size,
  startedAt
});

console.log('[moneyball] this packaged asset is a strategy manifest bridge, not a live execution adapter');
console.log('[moneyball] metrics', SYSTEM.metrics || {});
console.log('[moneyball] spec', SYSTEM.spec || {});

setInterval(() => {
  console.log('[moneyball] heartbeat', {
    id: SYSTEM.id,
    family: SYSTEM.family,
    status: SYSTEM.status,
    size,
    ts: new Date().toISOString()
  });
}, 60000);
