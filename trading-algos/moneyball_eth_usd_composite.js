'use strict';

/* @algo
{
  "description": "Composite view of the promoted ETH/USD Moneyball strategy portfolio.",
  "mode": "FUTURES",
  "name": "Moneyball ETH/USD Composite",
  "parameters": {
    "family": "composite",
    "metrics": {
      "effective_diversification_note": "About 11 effective sleeves because post_impulse_shelf_reclaim_anchor_best_sparse and post_impulse_shelf_reclaim_00028_best_sparse are highly correlated.",
      "family_count": 3,
      "family_status": {
        "cross_family_regime_scalpers": "promoted_adapter_ready",
        "no_btc_sideways_range_cross": "adapter_parity_validated_tiny_live_running",
        "post_impulse_shelf_reclaim": "research_promoted_adapter_in_progress"
      },
      "named_sleeves": 12,
      "research_promoted_pending_adapter_sleeves": 3,
      "strict_live_or_adapter_ready_sleeves": 9
    },
    "status": "read_only_bridge"
  },
  "risk": {
    "liveExecution": false,
    "note": "Packaged read-only manifest bridge. Enable live execution only after adapter parity and sizing approval."
  },
  "symbol": "ETH/USD",
  "tags": [
    "moneyball",
    "composite",
    "read_only_bridge"
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
  "composite": {
    "effective_diversification_note": "About 11 effective sleeves because post_impulse_shelf_reclaim_anchor_best_sparse and post_impulse_shelf_reclaim_00028_best_sparse are highly correlated.",
    "family_count": 3,
    "family_status": {
      "cross_family_regime_scalpers": "promoted_adapter_ready",
      "no_btc_sideways_range_cross": "adapter_parity_validated_tiny_live_running",
      "post_impulse_shelf_reclaim": "research_promoted_adapter_in_progress"
    },
    "named_sleeves": 12,
    "research_promoted_pending_adapter_sleeves": 3,
    "strict_live_or_adapter_ready_sleeves": 9
  },
  "families": [
    {
      "id": "cross_family_regime_scalpers",
      "portfolio_metrics": {
        "day_drawdown": 32.116114,
        "ev": 0.294093,
        "net": 510.250876,
        "positive_months": 29,
        "trade_drawdown": 34.789958,
        "trades": 1735,
        "worst_month": -23.284993
      },
      "sleeve_count": 6,
      "status": "promoted_adapter_ready"
    },
    {
      "id": "no_btc_sideways_range_cross",
      "portfolio_metrics": {
        "day_drawdown": 20.915583,
        "ev": 1.205634,
        "months": 36,
        "net": 171.200016,
        "positive_months": 32,
        "trade_drawdown": 20.915583,
        "trades": 142,
        "worst_month": -6.267154
      },
      "sleeve_count": 3,
      "status": "adapter_parity_validated_tiny_live_running"
    },
    {
      "id": "post_impulse_shelf_reclaim",
      "portfolio_metrics": {},
      "sleeve_count": 3,
      "status": "research_promoted_adapter_in_progress"
    }
  ],
  "family": "composite",
  "id": "moneyball_eth_usd_composite",
  "market": "ETH/USD",
  "mode": "composite_portfolio",
  "status": "read_only_bridge"
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
