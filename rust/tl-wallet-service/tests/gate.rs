use tl_wallet_service::gate::*;

const TOKEN_HEX: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

fn gate() -> Gate {
    Gate::new(GateConfig {
        port: 1986,
        token: SessionToken::from_hex(TOKEN_HEX).unwrap(),
        allowed_origins: vec!["file://".into(), "http://localhost:4200".into()],
        methods: MethodAllowlist::wallet_default(),
    })
}

fn good() -> RequestMeta<'static> {
    RequestMeta {
        peer_is_loopback: true,
        host: Some("localhost:1986"),
        origin: Some("file://"),
        token: Some(TOKEN_HEX),
    }
}

#[test]
fn admits_a_fully_valid_request() {
    assert_eq!(gate().check(&good()), Ok(()));
    // native (non-browser) client: no Origin
    let m = RequestMeta {
        origin: None,
        ..good()
    };
    assert_eq!(gate().check(&m), Ok(()));
    for h in ["127.0.0.1:1986", "[::1]:1986", "LOCALHOST:1986"] {
        let m = RequestMeta {
            host: Some(h),
            ..good()
        };
        assert_eq!(gate().check(&m), Ok(()), "{h}");
    }
}

#[test]
fn repaired_unauthenticated_requests_are_refused() {
    // legacy: every route answered without any credential
    let m = RequestMeta {
        token: None,
        ..good()
    };
    assert_eq!(gate().check(&m), Err(Deny::MissingToken));
    assert_eq!(Deny::MissingToken.status(), 401);
    let m = RequestMeta {
        token: Some("00".repeat(32).leak()),
        ..good()
    };
    assert_eq!(gate().check(&m), Err(Deny::BadToken));
    let m = RequestMeta {
        token: Some(""),
        ..good()
    };
    assert_eq!(gate().check(&m), Err(Deny::BadToken));
    // prefix / extension of the right token
    let m = RequestMeta {
        token: Some(&TOKEN_HEX[..63]),
        ..good()
    };
    assert_eq!(gate().check(&m), Err(Deny::BadToken));
    let long = format!("{TOKEN_HEX}00");
    let m = RequestMeta {
        token: Some(long.leak()),
        ..good()
    };
    assert_eq!(gate().check(&m), Err(Deny::BadToken));
}

#[test]
fn repaired_cors_wildcard_origin_and_foreign_origins() {
    for o in [
        "https://evil.example",
        "null",
        "http://localhost:4201",
        "FILE://",
        "*",
    ] {
        let m = RequestMeta {
            origin: Some(o),
            ..good()
        };
        assert_eq!(gate().check(&m), Err(Deny::ForbiddenOrigin), "{o}");
        assert_eq!(gate().cors_allow_origin(Some(o)), None, "{o}");
    }
    assert_eq!(
        gate()
            .cors_allow_origin(Some("http://localhost:4200"))
            .as_deref(),
        Some("http://localhost:4200")
    );
    assert_eq!(gate().cors_allow_origin(None), None);
}

#[test]
fn repaired_dns_rebinding_host_and_remote_peers() {
    for h in [
        None,
        Some("evil.example:1986"),
        Some("localhost"),
        Some("localhost:1987"),
        Some("localhost:1986.evil.example"),
        Some("127.0.0.1.evil.example:1986"),
        Some("user@localhost:1986"),
        Some("0.0.0.0:1986"),
    ] {
        let m = RequestMeta { host: h, ..good() };
        assert_eq!(gate().check(&m), Err(Deny::BadHost), "{h:?}");
    }
    let m = RequestMeta {
        peer_is_loopback: false,
        ..good()
    };
    assert_eq!(gate().check(&m), Err(Deny::NotLoopbackPeer));
}

#[test]
fn preflight_needs_origin_but_no_token() {
    let m = RequestMeta {
        token: None,
        ..good()
    };
    assert_eq!(gate().check_preflight(&m), Ok(()));
    let m = RequestMeta {
        token: None,
        origin: Some("https://evil.example"),
        ..good()
    };
    assert_eq!(gate().check_preflight(&m), Err(Deny::ForbiddenOrigin));
    let m = RequestMeta {
        token: None,
        origin: None,
        ..good()
    };
    assert_eq!(gate().check_preflight(&m), Err(Deny::ForbiddenOrigin));
}

#[test]
fn repaired_rpc_proxy_forwards_only_allowlisted_methods() {
    let g = gate();
    for ok in [
        "validateaddress",
        "listunspent",
        "sendrawtransaction",
        "tl_getinfo",
        "tl_createpayload_simplesend",
        "tl_createpayload_instant_trade",
    ] {
        assert_eq!(g.check_rpc(ok, 1), Ok(()), "{ok}");
    }
    for bad in [
        "dumpprivkey",
        "dumpwallet",
        "importprivkey",
        "walletpassphrase",
        "sendtoaddress",
        "stop",
        "setgenerate",
        "settxfee",
        "walletpassphrasechange",
        "backupwallet",
        "getblockchaininfo ",
        "ValidateAddress",
        "",
        "xtl_createpayload_simplesend",
        "validateaddress\n",
        "validate.address",
    ] {
        assert_eq!(g.check_rpc(bad, 0), Err(Deny::MethodNotAllowed), "{bad:?}");
    }
    assert_eq!(
        g.check_rpc("listunspent", MAX_RPC_PARAMS + 1),
        Err(Deny::TooManyParams)
    );
    assert_eq!(g.check_rpc(&"a".repeat(65), 0), Err(Deny::MethodNotAllowed));
}

#[test]
fn token_constructor_rejects_weak_tokens() {
    assert_eq!(SessionToken::from_hex("ab"), Err(TokenError::WrongLength));
    assert_eq!(
        SessionToken::from_hex(&"zz".repeat(32)),
        Err(TokenError::NotHex)
    );
    assert_eq!(
        SessionToken::from_hex(&"00".repeat(32)),
        Err(TokenError::Degenerate)
    );
    assert_eq!(
        SessionToken::from_bytes(&[7u8; 31]),
        Err(TokenError::WrongLength)
    );
    let t = SessionToken::from_hex(TOKEN_HEX).unwrap();
    assert_eq!(t.to_hex(), TOKEN_HEX);
    assert!(t.verify(&TOKEN_HEX.to_uppercase()));
    assert_eq!(format!("{t:?}"), "SessionToken(<redacted>)");
}
