/-!
# Order amount reservation (models `OrderBook::reserve_for`, `release`, `settle` in
`src/swap/order.rs`)

Abstraction: one order. The Rust book keeps many orders, each with its own reservation list; the
reservations of different orders never interact (a trade is reserved on exactly one order), so the
single-order model is the per-order behaviour. Key-held / side / market / limit-price fitting is
`find_fit` and is covered by the Rust tests, not by this model.
-/
namespace TlWalletService.Order

structure Book where
  /-- open amount of the order (reserved part included) -/
  amount : Nat
  /-- reservations as (trade id, amount) -/
  res : List (Nat × Nat)
  deriving DecidableEq, Repr

def reserved (b : Book) : Nat := (b.res.map Prod.snd).sum

def hasTrade (b : Book) (t : Nat) : Bool := b.res.any (fun r => r.1 == t)

/-- Amount reserved by trade `t`. -/
def resOf (b : Book) (t : Nat) : Nat := ((b.res.filter (fun r => r.1 == t)).map Prod.snd).sum

/-- `reserve_for`: refuse a duplicate trade, a zero amount, or one that exceeds the unreserved
remainder. -/
def reserve (b : Book) (t a : Nat) : Option Book :=
  if hasTrade b t || a == 0 || b.amount < reserved b + a then none
  else some { b with res := (t, a) :: b.res }

/-- `release`: abort or timeout gives the amount back. -/
def release (b : Book) (t : Nat) : Book :=
  { b with res := b.res.filter (fun r => !(r.1 == t)) }

/-- `settle`: the reserved amount is filled; the order shrinks by it. -/
def settle (b : Book) (t : Nat) : Book :=
  { amount := b.amount - resOf b t, res := b.res.filter (fun r => !(r.1 == t)) }

/-- The invariant checked by `OrderBook::invariant_holds`. -/
def Inv (b : Book) : Prop := reserved b ≤ b.amount

theorem sum_partition (l : List (Nat × Nat)) (t : Nat) :
    ((l.filter (fun r => r.1 == t)).map Prod.snd).sum +
      ((l.filter (fun r => !(r.1 == t))).map Prod.snd).sum = (l.map Prod.snd).sum := by
  induction l with
  | nil => simp
  | cons x xs ih =>
    by_cases h : x.1 = t
    · simp [h]; omega
    · simp [h]; omega

theorem reserved_release (b : Book) (t : Nat) :
    reserved (release b t) + resOf b t = reserved b := by
  have := sum_partition b.res t
  simp only [reserved, release, resOf]
  omega

theorem resOf_le_reserved (b : Book) (t : Nat) : resOf b t ≤ reserved b := by
  have := sum_partition b.res t
  simp only [reserved, resOf]
  omega

theorem reserved_cons (b : Book) (t a : Nat) :
    reserved { b with res := (t, a) :: b.res } = a + reserved b := by
  simp [reserved]

/-- A successful reservation never exceeds the order amount (no precondition needed). -/
theorem reserve_within_order (b b' : Book) (t a : Nat) (h : reserve b t a = some b') :
    reserved b' ≤ b'.amount := by
  unfold reserve at h
  split at h
  · simp at h
  · next hc =>
    simp at h
    subst h
    simp only [reserved_cons]
    simp [Bool.or_eq_true] at hc
    omega

theorem reserve_preserves_inv (b b' : Book) (t a : Nat) (h : reserve b t a = some b') :
    Inv b' := reserve_within_order b b' t a h

theorem reserve_amount_unchanged (b b' : Book) (t a : Nat) (h : reserve b t a = some b') :
    b'.amount = b.amount := by
  unfold reserve at h
  split at h
  · simp at h
  · simp at h; subst h; rfl

/-- Two swaps cannot over-reserve: once `t1` holds `a1`, a second reservation that would push the
total above the order amount is refused. -/
theorem two_swaps_cannot_overreserve (b b1 : Book) (t1 t2 a1 a2 : Nat)
    (h1 : reserve b t1 a1 = some b1) (hover : b.amount < reserved b + a1 + a2) :
    reserve b1 t2 a2 = none := by
  have hamt := reserve_amount_unchanged b b1 t1 a1 h1
  have hres : reserved b1 = a1 + reserved b := by
    unfold reserve at h1
    split at h1
    · simp at h1
    · simp at h1; subst h1; exact reserved_cons b t1 a1
  unfold reserve
  have : b1.amount < reserved b1 + a2 := by omega
  simp [this]

/-- Release restores exactly what was there before the reservation. -/
theorem release_restores (b b1 : Book) (t a : Nat) (h : reserve b t a = some b1) :
    release b1 t = b := by
  unfold reserve at h
  split at h
  · simp at h
  · next hc =>
    simp at h
    subst h
    simp only [Bool.or_eq_true, not_or] at hc
    have hno : ∀ r ∈ b.res, (r.1 == t) = false := by
      intro r hr
      cases hh : (r.1 == t) with
      | false => rfl
      | true =>
        exfalso
        have : hasTrade b t = true := by
          unfold hasTrade
          rw [List.any_eq_true]
          exact ⟨r, hr, hh⟩
        exact hc.1.1 this
    have hf : b.res.filter (fun r => !(r.1 == t)) = b.res := by
      apply List.filter_eq_self.mpr
      intro r hr
      simp [hno r hr]
    have hc2 : List.filter (fun r : Nat × Nat => !(r.1 == t)) ((t, a) :: b.res) = b.res := by
      rw [List.filter_cons]
      simp [hf]
    unfold release
    rw [hc2]

theorem release_preserves_inv (b : Book) (t : Nat) (h : Inv b) : Inv (release b t) := by
  have := reserved_release b t
  unfold Inv at *
  have h2 : (release b t).amount = b.amount := rfl
  omega

/-- Settlement removes exactly the trade's reservation from both the order and the reservations. -/
theorem settle_conserves (b : Book) (t : Nat) (h : Inv b) :
    (settle b t).amount + resOf b t = b.amount ∧
      reserved (settle b t) + resOf b t = reserved b := by
  have h1 := resOf_le_reserved b t
  have h2 := reserved_release b t
  unfold Inv at h
  refine ⟨?_, ?_⟩
  · simp only [settle]; omega
  · simpa [settle, release, reserved] using h2

theorem settle_preserves_inv (b : Book) (t : Nat) (h : Inv b) : Inv (settle b t) := by
  have ⟨h1, h2⟩ := settle_conserves b t h
  unfold Inv at *
  omega

/-! ### Vectors shared with `tests/swap.rs::reservation_never_exceeds_the_order_and_release_restores` -/

def b0 : Book := { amount := 1000, res := [] }

example : (reserve b0 1 400).isSome = true := by decide
example : (reserve b0 1 400 >>= fun b => reserve b 2 400).isSome = true := by decide
example : (reserve b0 1 400 >>= fun b => reserve b 2 400 >>= fun b => reserve b 3 400) = none := by
  decide
example : (reserve b0 1 400 >>= fun b => reserve b 1 100) = none := by decide
example : reserve b0 1 0 = none := by decide
example : reserve b0 1 1001 = none := by decide
example : (reserve b0 1 1000).isSome = true := by decide
-- release restores the unreserved amount and lets the third swap in
example : ((reserve b0 1 400 >>= fun b => reserve b 2 400).map (fun b => release b 1)
    >>= fun b => reserve b 3 400).isSome = true := by decide
-- settlement shrinks the order by the trade's amount
example : (reserve b0 1 300).map (fun b => (settle b 1).amount) = some 700 := by decide
example : (reserve b0 1 300).map (fun b => reserved (settle b 1)) = some 0 := by decide

end TlWalletService.Order
