/-!
# Channel swap state machine (models `src/swap/machine.rs`)

Abstractions (also listed in the README):
* trade ids and session ids are `Nat`s; equality stands for the SHA-256 derived ids/sessions;
* the transcript digest is the list of accepted step numbers (most recent first); the Rust digest
  is a collision-resistant hash of that list, so `prev = head` is modelled as list equality;
* payload syntax/shape validation is a `Bool` carried by the envelope (`payloadOk`);
* time is a `Nat` of milliseconds.
-/
namespace TlWalletService.Swap

inductive Role where
  | buyer
  | seller
  deriving DecidableEq, Repr

def Role.other : Role → Role
  | .buyer => .seller
  | .seller => .buyer

inductive Status where
  | active
  | settled
  | terminated
  | timedOut
  deriving DecidableEq, Repr

/-- `Step::sender`: odd steps belong to the seller, even steps to the buyer. -/
def sender (n : Nat) : Role := if n % 2 == 1 then .seller else .buyer

structure Swap where
  role : Role
  trade : Nat
  peer : Nat
  /-- accepted step numbers, most recent first -/
  head : List Nat
  done : Nat
  status : Status
  deadline : Nat
  deriving DecidableEq, Repr

/-- The step numbers `n, n-1, ..., 1`. -/
def stepsUpTo : Nat → List Nat
  | 0 => []
  | n + 1 => (n + 1) :: stepsUpTo n

def Swap.init (role : Role) (trade peer now timeout : Nat) : Swap :=
  { role, trade, peer, head := [], done := 0, status := .active, deadline := now + timeout }

structure Env where
  trade : Nat
  src : Nat
  /-- `none` is `TERMINATE_TRADE` -/
  step : Option Nat
  prev : List Nat
  payloadOk : Bool

/-- `Swap::tick`. -/
def tick (s : Swap) (now : Nat) : Swap :=
  if s.status == .active && s.deadline ≤ now then { s with status := .timedOut } else s

def finishIfComplete (s : Swap) : Swap :=
  if s.done == 6 then { s with status := .settled } else s

/-- Body of `Swap::receive` after the clock was applied. -/
def recvCore (s : Swap) (e : Env) : Swap × Bool :=
  if s.status != .active then (s, false)
  else if e.trade != s.trade then (s, false)
  else if e.src != s.peer then (s, false)
  else if !e.payloadOk then (s, false)
  else
    match e.step with
    | none => ({ s with status := .terminated }, true)
    | some n =>
      if n == s.done + 1 && sender n == s.role.other && e.prev == s.head then
        (finishIfComplete { s with head := n :: s.head, done := s.done + 1 }, true)
      else (s, false)

/-- `Swap::receive`; the result is the new state and whether the envelope was accepted. -/
def receive (s : Swap) (e : Env) (now : Nat) : Swap × Bool := recvCore (tick s now) e

/-- Body of `Swap::send` after the clock was applied. -/
def sendCore (s : Swap) (n : Nat) (payloadOk : Bool) : Swap × Bool :=
  if s.status != .active then (s, false)
  else if n == s.done + 1 && sender n == s.role && payloadOk then
    (finishIfComplete { s with head := n :: s.head, done := s.done + 1 }, true)
  else (s, false)

/-- `Swap::send`. -/
def send (s : Swap) (n : Nat) (payloadOk : Bool) (now : Nat) : Swap × Bool :=
  sendCore (tick s now) n payloadOk

/-- `Swap::terminate`. -/
def terminate (s : Swap) : Swap × Bool :=
  if s.status == .active then ({ s with status := .terminated }, true) else (s, false)

/-! ### Reachable states and the invariant -/

inductive Reachable : Swap → Prop where
  | init (role : Role) (trade peer now timeout : Nat) :
      Reachable (Swap.init role trade peer now timeout)
  | recv {s : Swap} (e : Env) (now : Nat) : Reachable s → Reachable (receive s e now).1
  | send {s : Swap} (n : Nat) (ok : Bool) (now : Nat) : Reachable s → Reachable (send s n ok now).1
  | term {s : Swap} : Reachable s → Reachable (terminate s).1
  | tick {s : Swap} (now : Nat) : Reachable s → Reachable (tick s now)

structure Inv (s : Swap) : Prop where
  head : s.head = stepsUpTo s.done
  bound : s.done ≤ 6
  settled : s.status = .settled → s.done = 6
  full : s.done = 6 → s.status ≠ .active

theorem inv_init (role : Role) (trade peer now timeout : Nat) :
    Inv (Swap.init role trade peer now timeout) :=
  ⟨rfl, by simp [Swap.init], by simp [Swap.init], by simp [Swap.init]⟩

theorem inv_tick {s : Swap} (h : Inv s) (now : Nat) : Inv (tick s now) := by
  unfold tick
  split
  · exact ⟨h.head, h.bound, fun hs => by simp at hs, fun _ => by simp⟩
  · exact h

/-- Accepting step `done + 1` of an active swap keeps the invariant. -/
theorem inv_accept {s : Swap} (h : Inv s) (ha : s.status = .active) (n : Nat)
    (hn : n = s.done + 1) :
    Inv (finishIfComplete { s with head := n :: s.head, done := s.done + 1 }) := by
  have hlt : s.done < 6 :=
    Nat.lt_of_le_of_ne h.bound (fun h6 => h.full h6 ha)
  unfold finishIfComplete
  split
  · next hd =>
    have h6 : s.done + 1 = 6 := by simpa using hd
    exact ⟨by subst hn; simp [stepsUpTo, h.head], by simp; omega, fun _ => by simpa using h6,
      fun _ => by simp⟩
  · next hd =>
    have h6 : ¬ s.done + 1 = 6 := by simpa using hd
    refine ⟨by subst hn; simp [stepsUpTo, h.head], by simp; omega, ?_, ?_⟩
    · intro hs; exact absurd (h.settled hs) (by omega)
    · intro hd6; exact absurd hd6 (by simp; omega)

theorem inv_receive {s : Swap} (h : Inv s) (e : Env) (now : Nat) : Inv (receive s e now).1 := by
  have h1 := inv_tick h now
  unfold receive recvCore
  generalize tick s now = t at h1 ⊢
  split
  · exact h1
  · next hnot =>
    split
    · exact h1
    · split
      · exact h1
      · split
        · exact h1
        · split
          · exact ⟨h1.head, h1.bound, fun hh => by simp at hh, fun _ => by simp⟩
          · split
            · next hc =>
              have hact : t.status = .active := by simpa using hnot
              simp [Bool.and_eq_true] at hc
              exact inv_accept h1 hact _ (by omega)
            · exact h1

theorem inv_send {s : Swap} (h : Inv s) (n : Nat) (ok : Bool) (now : Nat) :
    Inv (send s n ok now).1 := by
  have h1 := inv_tick h now
  unfold send sendCore
  generalize tick s now = t at h1 ⊢
  split
  · exact h1
  · next hnot =>
    split
    · next hd =>
      have hact : t.status = .active := by simpa using hnot
      simp [Bool.and_eq_true] at hd
      exact inv_accept h1 hact _ (by omega)
    · exact h1

theorem inv_terminate {s : Swap} (h : Inv s) : Inv (terminate s).1 := by
  unfold terminate
  split
  · exact ⟨h.head, h.bound, fun hh => by simp at hh, fun _ => by simp⟩
  · exact h

theorem reachable_inv {s : Swap} (r : Reachable s) : Inv s := by
  induction r with
  | init role trade peer now timeout => exact inv_init role trade peer now timeout
  | recv e now _ ih => exact inv_receive ih e now
  | send n ok now _ ih => exact inv_send ih n ok now
  | term _ ih => exact inv_terminate ih
  | tick now _ ih => exact inv_tick ih now

/-! ### Main theorems -/

/-- Settlement needs every step, in order: the transcript is exactly `6,5,4,3,2,1`. -/
theorem settled_needs_all_steps {s : Swap} (r : Reachable s) (h : s.status = .settled) :
    s.done = 6 ∧ s.head = [6, 5, 4, 3, 2, 1] := by
  have i := reachable_inv r
  have h6 := i.settled h
  refine ⟨h6, ?_⟩
  rw [i.head, h6]
  rfl

/-- Steps are only accepted in order: an accepted step is exactly the next one. -/
theorem receive_in_order (s : Swap) (e : Env) (now : Nat) (n : Nat)
    (hs : e.step = some n) (hacc : (receive s e now).2 = true) :
    n = (tick s now).done + 1 := by
  unfold receive recvCore at hacc
  generalize tick s now = t at hacc ⊢
  simp only [hs] at hacc
  split at hacc <;> try (simp at hacc; done)
  split at hacc <;> try (simp at hacc; done)
  split at hacc <;> try (simp at hacc; done)
  split at hacc <;> try (simp at hacc; done)
  split at hacc
  · next hc => simp at hc; omega
  · simp at hacc

/-- Every accepted envelope is bound to this trade and this counterparty session. -/
theorem receive_bound_to_trade_and_peer (s : Swap) (e : Env) (now : Nat)
    (hacc : (receive s e now).2 = true) :
    e.trade = s.trade ∧ e.src = s.peer := by
  unfold receive recvCore at hacc
  have ht : (tick s now).trade = s.trade := by unfold tick; split <;> rfl
  have hp : (tick s now).peer = s.peer := by unfold tick; split <;> rfl
  rw [← ht, ← hp]
  generalize tick s now = t at hacc ⊢
  split at hacc
  · simp at hacc
  · split at hacc
    · simp at hacc
    · next h2 =>
      split at hacc
      · simp at hacc
      · next h3 =>
        simp at h2 h3
        exact ⟨h2, h3⟩

/-- An accepted numbered step also carries the digest of the previous accepted step. -/
theorem receive_bound_to_previous (s : Swap) (e : Env) (now : Nat) (n : Nat)
    (hs : e.step = some n) (hacc : (receive s e now).2 = true) :
    e.prev = (tick s now).head := by
  unfold receive recvCore at hacc
  generalize tick s now = t at hacc ⊢
  simp only [hs] at hacc
  split at hacc <;> try (simp at hacc; done)
  split at hacc <;> try (simp at hacc; done)
  split at hacc <;> try (simp at hacc; done)
  split at hacc <;> try (simp at hacc; done)
  split at hacc
  · next hc => simp at hc; exact hc.2
  · simp at hacc

/-- The sender of an accepted numbered step is the counterparty role. -/
theorem receive_sender_is_peer_role (s : Swap) (e : Env) (now : Nat) (n : Nat)
    (hs : e.step = some n) (hacc : (receive s e now).2 = true) :
    sender n = s.role.other := by
  unfold receive recvCore at hacc
  have hr : (tick s now).role = s.role := by unfold tick; split <;> rfl
  rw [← hr]
  generalize tick s now = t at hacc ⊢
  simp only [hs] at hacc
  split at hacc <;> try (simp at hacc; done)
  split at hacc <;> try (simp at hacc; done)
  split at hacc <;> try (simp at hacc; done)
  split at hacc <;> try (simp at hacc; done)
  split at hacc
  · next hc => simp at hc; exact hc.1.2
  · simp at hacc

/-- Nothing is accepted or sent once the swap is settled, terminated or timed out. -/
theorem finished_is_final (s : Swap) (hf : s.status ≠ .active) (e : Env) (now : Nat) (n : Nat)
    (ok : Bool) :
    (receive s e now).2 = false ∧ (send s n ok now).2 = false ∧ (terminate s).2 = false := by
  have ht : tick s now = s := by
    unfold tick
    split
    · next hc => simp [Bool.and_eq_true] at hc; exact absurd hc.1 hf
    · rfl
  refine ⟨?_, ?_, ?_⟩
  · unfold receive recvCore; rw [ht]; simp [hf]
  · unfold send sendCore; rw [ht]; simp [hf]
  · unfold terminate; simp [hf]

/-- After the deadline no envelope is accepted and no step is sent. -/
theorem no_step_after_timeout (s : Swap) (now : Nat) (hd : s.deadline ≤ now) (e : Env) (n : Nat)
    (ok : Bool) :
    (receive s e now).2 = false ∧ (send s n ok now).2 = false := by
  have ht : (tick s now).status ≠ .active := by
    unfold tick
    split
    · simp
    · next hc =>
      by_cases ha : s.status = .active
      · exfalso; apply hc; simp [ha, hd]
      · exact ha
  refine ⟨?_, ?_⟩
  · unfold receive recvCore; generalize tick s now = u at ht ⊢; simp [ht]
  · unfold send sendCore; generalize tick s now = u at ht ⊢; simp [ht]

/-- Terminating an active swap is final. -/
theorem terminate_then_final (s : Swap) (ha : s.status = .active) (e : Env) (now : Nat) :
    (receive (terminate s).1 e now).2 = false := by
  have h : (terminate s).1.status = .terminated := by unfold terminate; simp [ha]
  have := finished_is_final (terminate s).1 (by rw [h]; simp) e now 0 true
  exact this.1

/-- Senders alternate, so the two sides can never both own a step. -/
theorem sender_alternates (n : Nat) : sender n ≠ sender (n + 1) := by
  unfold sender
  rcases Nat.mod_two_eq_zero_or_one n with h | h
  · have : (n + 1) % 2 = 1 := by omega
    simp [h, this]
  · have : (n + 1) % 2 = 0 := by omega
    simp [h, this]

/-! ### Vectors shared with `tests/swap.rs` -/

example : sender 1 = .seller := by decide
example : sender 2 = .buyer := by decide
example : sender 5 = .seller := by decide
example : sender 6 = .buyer := by decide

/-- Run of the happy path: the seller sends 1, 3, 5; the buyer receives them and sends 2, 4, 6. -/
def run6 : Swap × Swap :=
  let b0 := Swap.init .buyer 7 2 0 60000
  let s0 := Swap.init .seller 7 1 0 60000
  let env (src n : Nat) (prev : List Nat) : Env :=
    { trade := 7, src, step := some n, prev, payloadOk := true }
  let s1 := (send s0 1 true 1).1
  let b1 := (receive b0 (env 2 1 []) 1).1
  let b2 := (send b1 2 true 2).1
  let s2 := (receive s1 (env 1 2 [1]) 2).1
  let s3 := (send s2 3 true 3).1
  let b3 := (receive b2 (env 2 3 [2, 1]) 3).1
  let b4 := (send b3 4 true 4).1
  let s4 := (receive s3 (env 1 4 [3, 2, 1]) 4).1
  let s5 := (send s4 5 true 5).1
  let b5 := (receive b4 (env 2 5 [4, 3, 2, 1]) 5).1
  let b6 := (send b5 6 true 6).1
  let s6 := (receive s5 (env 1 6 [5, 4, 3, 2, 1]) 6).1
  (b6, s6)

example : run6.1.status = .settled := by decide
example : run6.2.status = .settled := by decide
example : run6.1.head = [6, 5, 4, 3, 2, 1] := by decide
example : run6.2.head = [6, 5, 4, 3, 2, 1] := by decide

-- a skipped step, a foreign trade, a spoofed session and a stale digest are all refused
example : (receive (Swap.init .buyer 7 2 0 60000) ⟨7, 2, some 3, [], true⟩ 1).2 = false := by decide
example : (receive (Swap.init .buyer 7 2 0 60000) ⟨8, 2, some 1, [], true⟩ 1).2 = false := by decide
example : (receive (Swap.init .buyer 7 2 0 60000) ⟨7, 9, some 1, [], true⟩ 1).2 = false := by decide
example : (receive (Swap.init .buyer 7 2 0 60000) ⟨7, 2, some 1, [5], true⟩ 1).2 = false := by decide
example : (receive (Swap.init .buyer 7 2 0 60000) ⟨7, 2, some 1, [], true⟩ 1).2 = true := by decide
-- the 60 s deadline: accepted at 59_999, refused at 60_000
example : (receive (Swap.init .buyer 7 2 0 60000) ⟨7, 2, some 1, [], true⟩ 59999).2 = true := by decide
example : (receive (Swap.init .buyer 7 2 0 60000) ⟨7, 2, some 1, [], true⟩ 60000).2 = false := by decide

end TlWalletService.Swap
