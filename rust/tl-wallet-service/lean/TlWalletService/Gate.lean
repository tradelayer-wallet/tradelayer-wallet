/-!
# Service gate (models `src/gate.rs`)

A request is served only if the peer is loopback, the Host header is a loopback name with the
service port, the Origin (when present) is allowlisted, a valid session token is presented and the
RPC method is allowlisted.

Abstraction: header strings are compared by equality; the Rust token comparison is constant time
(timing is not modelled); `hosts` stands for the three `localhost|127.0.0.1|[::1]:port` spellings.
-/
namespace TlWalletService.Gate

structure Cfg where
  hosts : List String
  token : String
  origins : List String
  methods : List String

structure Req where
  loopback : Bool
  host : Option String
  origin : Option String
  token : Option String
  method : String

def hostOk (c : Cfg) (r : Req) : Bool :=
  match r.host with
  | some h => c.hosts.contains h
  | none => false

def originOk (c : Cfg) (r : Req) : Bool :=
  match r.origin with
  | some o => c.origins.contains o
  | none => true

def tokenOk (c : Cfg) (r : Req) : Bool :=
  match r.token with
  | some t => t == c.token
  | none => false

/-- `Gate::check`. -/
def admit (c : Cfg) (r : Req) : Bool :=
  r.loopback && hostOk c r && originOk c r && tokenOk c r

/-- `Gate::check` followed by `Gate::check_rpc` for the proxy route. -/
def serve (c : Cfg) (r : Req) : Bool :=
  admit c r && c.methods.contains r.method

/-- `Gate::cors_allow_origin`: only an allowlisted Origin is ever echoed. -/
def corsOrigin (c : Cfg) (o : Option String) : Option String :=
  match o with
  | some x => if c.origins.contains x then some x else none
  | none => none

theorem serve_iff (c : Cfg) (r : Req) :
    serve c r = true ↔
      r.loopback = true ∧ hostOk c r = true ∧ originOk c r = true ∧ tokenOk c r = true ∧
        c.methods.contains r.method = true := by
  simp [serve, admit, Bool.and_assoc, Bool.and_eq_true]

theorem no_token_no_service (c : Cfg) (r : Req) (h : r.token = none) : serve c r = false := by
  simp [serve, admit, tokenOk, h]

theorem wrong_token_no_service (c : Cfg) (r : Req) (t : String)
    (h : r.token = some t) (hne : t ≠ c.token) : serve c r = false := by
  simp [serve, admit, tokenOk, h, hne]

theorem foreign_origin_no_service (c : Cfg) (r : Req) (o : String)
    (h : r.origin = some o) (hno : o ∉ c.origins) : serve c r = false := by
  simp [serve, admit, originOk, h, hno]

theorem remote_peer_no_service (c : Cfg) (r : Req) (h : r.loopback = false) :
    serve c r = false := by
  simp [serve, admit, h]

theorem bad_host_no_service (c : Cfg) (r : Req) (h : hostOk c r = false) : serve c r = false := by
  simp [serve, admit, h]

theorem method_not_allowed_no_service (c : Cfg) (r : Req) (h : r.method ∉ c.methods) :
    serve c r = false := by
  simp [serve, h]

/-- Success implies a request that satisfied every individual check. -/
theorem serve_implies_token (c : Cfg) (r : Req) (h : serve c r = true) :
    r.token = some c.token := by
  have := (serve_iff c r).1 h
  obtain ⟨_, _, _, ht, _⟩ := this
  cases hr : r.token with
  | none => simp [tokenOk, hr] at ht
  | some t => simp [tokenOk, hr] at ht; simp [ht]

/-- The CORS header is never a wildcard and never a non-allowlisted origin. -/
theorem cors_only_allowlisted (c : Cfg) (o : Option String) (x : String)
    (h : corsOrigin c o = some x) : x ∈ c.origins ∧ o = some x := by
  cases o with
  | none => simp [corsOrigin] at h
  | some y =>
    simp only [corsOrigin] at h
    split at h
    · next hc =>
      simp at h
      subst h
      exact ⟨List.contains_iff_mem.mp hc, rfl⟩
    · simp at h

/-! ### Vectors shared with `tests/gate.rs` -/

def cfg : Cfg :=
  { hosts := ["localhost:1986", "127.0.0.1:1986", "[::1]:1986"]
    token := "tok"
    origins := ["file://", "http://localhost:4200"]
    methods := ["validateaddress", "listunspent", "sendrawtransaction"] }

def good : Req :=
  { loopback := true, host := some "localhost:1986", origin := some "file://",
    token := some "tok", method := "listunspent" }

example : serve cfg good = true := by decide
example : serve cfg { good with token := none } = false := by decide
example : serve cfg { good with token := some "bad" } = false := by decide
example : serve cfg { good with origin := some "https://evil.example" } = false := by decide
example : serve cfg { good with origin := some "*" } = false := by decide
example : serve cfg { good with origin := none } = true := by decide
example : serve cfg { good with host := some "evil.example:1986" } = false := by decide
example : serve cfg { good with host := some "localhost:1987" } = false := by decide
example : serve cfg { good with loopback := false } = false := by decide
example : serve cfg { good with method := "dumpprivkey" } = false := by decide
example : serve cfg { good with method := "stop" } = false := by decide
example : corsOrigin cfg (some "https://evil.example") = none := by decide
example : corsOrigin cfg (some "file://") = some "file://" := by decide

end TlWalletService.Gate
