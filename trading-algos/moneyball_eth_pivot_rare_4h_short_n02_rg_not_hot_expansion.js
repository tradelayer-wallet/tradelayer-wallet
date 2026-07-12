'use strict';

/* @algo
{
  "description": "Individual Moneyball sleeve from Cross-family regime scalpers.",
  "mode": "FUTURES",
  "name": "Moneyball eth_pivot_rare_4h_short_n02_rg_not_hot_expansion",
  "parameters": {
    "family": "cross_family_regime_scalpers",
    "metrics": {
      "day_drawdown": 129.08,
      "ev": 2.5695,
      "net": 925.02,
      "positive_months": 22,
      "trades": 360,
      "worst_month": -109.78
    },
    "status": "promoted_adapter_ready"
  },
  "risk": {
    "liveExecution": false,
    "note": "Packaged read-only manifest bridge. Enable live execution only after adapter parity and sizing approval."
  },
  "symbol": "ETH/USD",
  "tags": [
    "moneyball",
    "cross_family_regime_scalpers",
    "promoted_adapter_ready"
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
  "family": "cross_family_regime_scalpers",
  "id": "eth_pivot_rare_4h_short_n02_rg_not_hot_expansion",
  "market": "ETH/USD",
  "metrics": {
    "day_drawdown": 129.08,
    "ev": 2.5695,
    "net": 925.02,
    "positive_months": 22,
    "trades": 360,
    "worst_month": -109.78
  },
  "mode": "individual_sleeve",
  "spec": {
    "cooldown_sec": 115162,
    "fixed_stop_bps": 30.0,
    "max_hold_sec": 356259,
    "session_end_hour_utc": null,
    "session_start_hour_utc": null,
    "side_mode": "SHORT_ONLY",
    "stop_type": "trailing",
    "strategy_id": "eth_pivot_rare_4h_short_n02_rg_not_hot_expansion",
    "strategy_type": "pivot_bounce",
    "trail_pct_bps": 49.5088,
    "trail_timeframe": "1m"
  },
  "spec_path": "launch_specs/lighter_eth_cross_family_scalper_medium_regime_v1_20260505/strategies_active/eth_pivot_rare_4h_short_n02_rg_not_hot_expansion.json",
  "status": "promoted_adapter_ready"
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
