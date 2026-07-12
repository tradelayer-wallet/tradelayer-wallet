'use strict';

/* @algo
{
  "description": "Individual Moneyball sleeve from Post-impulse shelf reclaim.",
  "mode": "FUTURES",
  "name": "Moneyball post_impulse_shelf_reclaim_anchor_best_sparse",
  "parameters": {
    "family": "post_impulse_shelf_reclaim",
    "metrics": {
      "avg": 1.388821,
      "max_dd": 119.523515,
      "net": 848.569368,
      "positive_months": 29,
      "trades": 611,
      "worst_month": -62.163615
    },
    "status": "research_promoted_adapter_partial_parity"
  },
  "risk": {
    "liveExecution": false,
    "note": "Packaged read-only manifest bridge. Enable live execution only after adapter parity and sizing approval."
  },
  "symbol": "ETH/USD",
  "tags": [
    "moneyball",
    "post_impulse_shelf_reclaim",
    "research_promoted_adapter_partial_parity"
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
  "family": "post_impulse_shelf_reclaim",
  "id": "post_impulse_shelf_reclaim_anchor_best_sparse",
  "market": "ETH/USD",
  "metrics": {
    "avg": 1.388821,
    "max_dd": 119.523515,
    "net": 848.569368,
    "positive_months": 29,
    "trades": 611,
    "worst_month": -62.163615
  },
  "mode": "individual_sleeve",
  "spec": {
    "cooldown_sec": 1,
    "fixed_stop_bps": 30.0,
    "max_hold_sec": 3600,
    "range_cross_fee_bps_per_side": 0.2,
    "range_cross_max_drift_frac": 0.0,
    "range_cross_max_mid_dist_frac": 99.0,
    "range_cross_max_width_bps": 0.0,
    "range_cross_min_width_bps": 0.0,
    "range_cross_regime_lookback": 0,
    "range_cross_session": "all",
    "range_cross_signal_tf": "1m",
    "session_end_hour_utc": null,
    "session_start_hour_utc": null,
    "shelf_context_tf": "30m",
    "shelf_ema_period_5m": 34,
    "shelf_fee_bps_per_side": 0.2,
    "shelf_max_width_bps": 220.0,
    "shelf_min_impulse_bps": 45.0,
    "shelf_min_width_bps": 70.0,
    "shelf_session_hours_utc": [
      1,
      2,
      4,
      9,
      10,
      18,
      20
    ],
    "shelf_signal_tf": "5m",
    "shelf_target_loc_frac": 1.18,
    "side_mode": "BOTH",
    "stop_type": "trailing",
    "strategy_id": "post_impulse_shelf_reclaim_anchor_best_sparse",
    "strategy_type": "post_impulse_shelf_reclaim",
    "trail_pct_bps": 15.0,
    "trail_timeframe": "1m"
  },
  "spec_path": "portfolio_candidates/post_impulse_shelf_reclaim_adapter_specs/post_impulse_shelf_reclaim_anchor_best_sparse.json",
  "status": "research_promoted_adapter_partial_parity"
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
