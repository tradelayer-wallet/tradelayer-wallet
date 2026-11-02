import TlWalletService

-- service gate
#print axioms TlWalletService.Gate.serve_iff
#print axioms TlWalletService.Gate.no_token_no_service
#print axioms TlWalletService.Gate.wrong_token_no_service
#print axioms TlWalletService.Gate.foreign_origin_no_service
#print axioms TlWalletService.Gate.remote_peer_no_service
#print axioms TlWalletService.Gate.bad_host_no_service
#print axioms TlWalletService.Gate.method_not_allowed_no_service
#print axioms TlWalletService.Gate.serve_implies_token
#print axioms TlWalletService.Gate.cors_only_allowlisted

-- swap state machine
#print axioms TlWalletService.Swap.reachable_inv
#print axioms TlWalletService.Swap.settled_needs_all_steps
#print axioms TlWalletService.Swap.receive_in_order
#print axioms TlWalletService.Swap.receive_bound_to_trade_and_peer
#print axioms TlWalletService.Swap.receive_bound_to_previous
#print axioms TlWalletService.Swap.receive_sender_is_peer_role
#print axioms TlWalletService.Swap.finished_is_final
#print axioms TlWalletService.Swap.no_step_after_timeout
#print axioms TlWalletService.Swap.terminate_then_final
#print axioms TlWalletService.Swap.sender_alternates

-- amount reservation
#print axioms TlWalletService.Order.reserve_within_order
#print axioms TlWalletService.Order.reserve_preserves_inv
#print axioms TlWalletService.Order.two_swaps_cannot_overreserve
#print axioms TlWalletService.Order.release_restores
#print axioms TlWalletService.Order.release_preserves_inv
#print axioms TlWalletService.Order.settle_conserves
#print axioms TlWalletService.Order.settle_preserves_inv

-- transaction planner
#print axioms TlWalletService.TxBuilder.selectAux_eq_take
#print axioms TlWalletService.TxBuilder.planPayment_conserves
#print axioms TlWalletService.TxBuilder.planPayment_fee_exact
#print axioms TlWalletService.TxBuilder.planPayment_fee_bound
#print axioms TlWalletService.TxBuilder.planPayment_nonempty
#print axioms TlWalletService.TxBuilder.planPayment_to_ge_min
#print axioms TlWalletService.TxBuilder.planPayment_inputs_prefix
#print axioms TlWalletService.TxBuilder.planInstant_conserves
#print axioms TlWalletService.TxBuilder.finishInstant_buyer_min
#print axioms TlWalletService.TxBuilder.planInstant_keeps_commit_utxos

-- order form
#print axioms TlWalletService.OrderForm.cost_ge
#print axioms TlWalletService.OrderForm.cost_mono
#print axioms TlWalletService.OrderForm.maxBuy_affordable
#print axioms TlWalletService.OrderForm.maxBuy_maximal
#print axioms TlWalletService.OrderForm.sell_commits_amount
#print axioms TlWalletService.OrderForm.accepts_within_available
#print axioms TlWalletService.OrderForm.acceptsLtc_within_available
#print axioms TlWalletService.OrderForm.accepts_positive
#print axioms TlWalletService.OrderForm.max_buy_accepted
#print axioms TlWalletService.OrderForm.max_buy_plus_one_refused
#print axioms TlWalletService.OrderForm.countInputs_mono
#print axioms TlWalletService.OrderForm.feeLtc_bound
#print axioms TlWalletService.OrderForm.fitsLtc_downward

-- transaction forms
#print axioms TlWalletService.Forms.reqUp_inv
#print axioms TlWalletService.Forms.reqDown_inv
#print axioms TlWalletService.Forms.allUp_inv
#print axioms TlWalletService.Forms.allDown_inv
#print axioms TlWalletService.Forms.edited_blocks_build
#print axioms TlWalletService.Forms.only_valid_builds
#print axioms TlWalletService.Forms.withdraw_needs_validated_recipient
#print axioms TlWalletService.Forms.withdraw_within_bounds
