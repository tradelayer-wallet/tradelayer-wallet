//! The TradeLayer listener client for FE-speed's UI.
//!
//! FE-speed's wallet-server proxies to a Node process on `http://localhost:3000`; the UI also
//! calls that process directly (`/tlraw/` here, see `ui-overlay/fe-speed/rewrites.json`). In the
//! desktop build the listener is whatever answers on `tl_listener_url`: the TradeLayer-Rust
//! engine's HTTP face. This module is the transport only (loopback `http` or `https`, no proxy,
//! no redirects, bounded response, per-request timeout); which endpoints the page may reach is
//! decided by `tl_wallet_service::service`.

use super::{http_client_with, read_bounded, MAX_RESPONSE_BYTES};
use serde_json::Value;
use std::time::Duration;
use tl_wallet_service::service::{ListenerBackend, ListenerReply};

pub const DEFAULT_LISTENER_URL: &str = "http://127.0.0.1:3000";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Upper bound on any request; each call also passes its own (shorter or equal) timeout.
const MAX_TIMEOUT: Duration = Duration::from_secs(120);

fn is_loopback(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    h.eq_ignore_ascii_case("localhost")
        || h.parse::<std::net::IpAddr>()
            .map(|a| a.is_loopback())
            .unwrap_or(false)
}

/// The listener's exact origin: `http` or `https` to a loopback host, with no userinfo, path,
/// query or fragment. Returns the normalised origin (`http://127.0.0.1:3000`, default port
/// dropped, host lower-cased).
pub fn normalize_listener_url(url: &str) -> Result<String, String> {
    let u = reqwest::Url::parse(url).map_err(|_| "not a URL".to_string())?;
    let host = u.host_str().ok_or("URL has no host")?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err("scheme must be http or https".into());
    }
    if !is_loopback(host) {
        return Err("host must be loopback (localhost, 127.0.0.1 or [::1])".into());
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err("URL must not carry credentials".into());
    }
    if u.query().is_some() || u.fragment().is_some() || !matches!(u.path(), "" | "/") {
        return Err("URL must be an origin: no path, query or fragment".into());
    }
    Ok(u.origin().ascii_serialization())
}

/// Blocking HTTP client for the listener.
pub struct ListenerClient {
    base: reqwest::Url,
    origin: String,
    client: reqwest::blocking::Client,
}

impl ListenerClient {
    pub fn new(url: &str) -> Result<ListenerClient, String> {
        ListenerClient::with_timeouts(url, CONNECT_TIMEOUT, MAX_TIMEOUT)
    }

    pub(crate) fn with_timeouts(
        url: &str,
        connect: Duration,
        total: Duration,
    ) -> Result<ListenerClient, String> {
        let origin = normalize_listener_url(url)?;
        let base = reqwest::Url::parse(&format!("{origin}/")).map_err(|e| e.to_string())?;
        let client = http_client_with(&base, connect, total)?;
        Ok(ListenerClient {
            base,
            origin,
            client,
        })
    }

    /// axios's wording for a refused connection, with the numeric address.
    fn refused(&self) -> String {
        let host = match self.base.host_str() {
            Some("localhost") | None => "127.0.0.1",
            Some(h) => h.trim_start_matches('[').trim_end_matches(']'),
        };
        let port = self.base.port_or_known_default().unwrap_or(0);
        format!("connect ECONNREFUSED {host}:{port}")
    }
}

fn well_formed_endpoint(e: &str) -> bool {
    !e.is_empty() && e.len() <= 64 && e.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

impl ListenerBackend for ListenerClient {
    fn request(
        &mut self,
        method: &str,
        endpoint: &str,
        query: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<ListenerReply, String> {
        if !well_formed_endpoint(endpoint) {
            return Err("listener endpoint malformed".into());
        }
        let mut url = self.base.join(endpoint).map_err(|e| e.to_string())?;
        if !query.is_empty() {
            url.set_query(Some(query));
        }
        let timeout = timeout.min(MAX_TIMEOUT);
        let rb = match method {
            "GET" => self.client.get(url),
            "POST" => {
                let rb = self.client.post(url);
                match body {
                    Some(b) => rb
                        .header("Content-Type", "application/json")
                        .body(b.to_string()),
                    None => rb,
                }
            }
            _ => return Err("listener method not allowed".into()),
        };
        let resp = rb
            .header("Accept", "application/json, text/plain, */*")
            .timeout(timeout)
            .send()
            .map_err(|e| {
                if e.is_timeout() {
                    format!("timeout of {}ms exceeded", timeout.as_millis())
                } else if e.is_connect() {
                    self.refused()
                } else {
                    format!("request failed: {}", e.without_url())
                }
            })?;
        if resp
            .content_length()
            .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
        {
            return Err("response too large".into());
        }
        let status = resp.status().as_u16();
        let bytes = read_bounded(resp, MAX_RESPONSE_BYTES).map_err(|e| {
            if e.contains("response read failed") {
                // a read that ran into the timeout
                format!("timeout of {}ms exceeded", timeout.as_millis())
            } else {
                e
            }
        })?;
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice::<Value>(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };
        Ok(ListenerReply { status, body })
    }

    fn origin(&self) -> String {
        self.origin.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = stream.read(&mut chunk).unwrap_or(0);
            if n == 0 {
                return buf;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(h) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..h]).to_ascii_lowercase();
                let len = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buf.len() >= h + 4 + len {
                    return buf;
                }
            }
        }
    }

    /// One connection: read the request, then run `respond` on the stream.
    fn server(
        respond: impl FnOnce(&mut TcpStream) + Send + 'static,
    ) -> (u16, std::thread::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut st, _) = l.accept().unwrap();
            let req = read_request(&mut st);
            respond(&mut st);
            String::from_utf8_lossy(&req).into_owned()
        });
        (port, h)
    }

    fn canned(
        status: &str,
        content_type: &str,
        body: &[u8],
    ) -> impl FnOnce(&mut TcpStream) + Send + 'static {
        let mut v = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        v.extend_from_slice(body);
        move |st: &mut TcpStream| {
            let _ = st.write_all(&v);
            let _ = st.flush();
        }
    }

    fn client(port: u16) -> ListenerClient {
        ListenerClient::new(&format!("http://127.0.0.1:{port}")).unwrap()
    }

    const T: Duration = Duration::from_secs(5);

    #[test]
    fn urls_must_be_loopback_origins() {
        for (given, want) in [
            ("http://127.0.0.1:3000", "http://127.0.0.1:3000"),
            ("http://127.0.0.1:3000/", "http://127.0.0.1:3000"),
            ("HTTP://LocalHost:3000", "http://localhost:3000"),
            ("https://localhost", "https://localhost"),
            ("http://[::1]:3000", "http://[::1]:3000"),
            ("http://localhost:80", "http://localhost"),
        ] {
            assert_eq!(normalize_listener_url(given).unwrap(), want, "{given}");
        }
        for bad in [
            "",
            "127.0.0.1:3000",
            "ws://127.0.0.1:3000",
            "ftp://127.0.0.1",
            "http://example.com:3000",
            "http://192.168.1.5:3000",
            "http://127.0.0.1.example.com",
            "http://u:p@127.0.0.1:3000",
            "http://127.0.0.1:3000/x",
            "http://127.0.0.1:3000/?a=1",
            "http://127.0.0.1:3000/#f",
            "http://localhost@evil.example/",
        ] {
            assert!(normalize_listener_url(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            normalize_listener_url(DEFAULT_LISTENER_URL).unwrap(),
            DEFAULT_LISTENER_URL
        );
    }

    #[test]
    fn post_sends_the_json_body_and_returns_status_and_json() {
        let (port, h) = server(canned("200 OK", "application/json", br#"{"ok":[1,2]}"#));
        let mut c = client(port);
        let r = c
            .request("POST", "tl_getChannelColumn", "", Some(&json!({"a": 1})), T)
            .unwrap();
        assert_eq!(
            r,
            ListenerReply {
                status: 200,
                body: json!({"ok": [1, 2]})
            }
        );
        let raw = h.join().unwrap();
        assert!(
            raw.starts_with("POST /tl_getChannelColumn HTTP/1.1\r\n"),
            "{raw}"
        );
        assert!(raw
            .to_ascii_lowercase()
            .contains("content-type: application/json"));
        assert!(raw.ends_with(r#"{"a":1}"#));
    }

    #[test]
    fn get_carries_the_query_and_no_body() {
        let (port, h) = server(canned("200 OK", "application/json", b"[]"));
        let mut c = client(port);
        let r = c
            .request("GET", "tl_getContractInfo", "contractId=3&x=%20", None, T)
            .unwrap();
        assert_eq!(r.body, json!([]));
        let raw = h.join().unwrap();
        assert!(
            raw.starts_with("GET /tl_getContractInfo?contractId=3&x=%20 HTTP/1.1\r\n"),
            "{raw}"
        );
    }

    #[test]
    fn error_statuses_and_text_bodies_come_back_as_they_are() {
        let (port, _h) = server(canned(
            "500 Internal Server Error",
            "application/json",
            br#"{"error":"boom"}"#,
        ));
        let r = client(port)
            .request("POST", "tl_initmain", "", None, T)
            .unwrap();
        assert_eq!(
            r,
            ListenerReply {
                status: 500,
                body: json!({"error": "boom"})
            }
        );
        let (port, _h) = server(canned("200 OK", "text/plain", b"plain words"));
        let r = client(port)
            .request("POST", "tl_initmain", "", None, T)
            .unwrap();
        assert_eq!(r.body, json!("plain words"));
        let (port, _h) = server(canned("204 No Content", "text/plain", b""));
        let r = client(port)
            .request("POST", "tl_initmain", "", None, T)
            .unwrap();
        assert_eq!((r.status, r.body), (204, Value::Null));
        // redirects are not followed
        let (port, _h) = server(|st: &mut TcpStream| {
            let _ = st.write_all(
                b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        });
        let r = client(port)
            .request("POST", "tl_initmain", "", None, T)
            .unwrap();
        assert_eq!(r.status, 302);
    }

    #[test]
    fn a_closed_port_is_an_axios_style_refusal() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let e = client(port)
            .request("POST", "tl_getSyncStatus", "", None, T)
            .unwrap_err();
        assert_eq!(e, format!("connect ECONNREFUSED 127.0.0.1:{port}"));
    }

    #[test]
    fn a_listener_that_never_answers_times_out() {
        let (port, h) = server(|st: &mut TcpStream| {
            std::thread::sleep(Duration::from_millis(1500));
            let _ = st.flush();
        });
        let started = std::time::Instant::now();
        let e = client(port)
            .request(
                "POST",
                "tl_getSyncStatus",
                "",
                None,
                Duration::from_millis(300),
            )
            .unwrap_err();
        assert_eq!(e, "timeout of 300ms exceeded");
        assert!(started.elapsed() < Duration::from_millis(1400));
        let _ = h.join();
    }

    #[test]
    fn a_body_that_stalls_part_way_times_out() {
        let (port, h) = server(|st: &mut TcpStream| {
            let _ = st.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"a\"",
            );
            let _ = st.flush();
            std::thread::sleep(Duration::from_millis(1500));
        });
        let e = client(port)
            .request(
                "POST",
                "tl_getSyncStatus",
                "",
                None,
                Duration::from_millis(300),
            )
            .unwrap_err();
        assert!(e.starts_with("timeout of 300ms"), "{e}");
        let _ = h.join();
    }

    #[test]
    fn responses_over_8_mib_are_refused() {
        // announced length
        let (port, _h) = server(|st: &mut TcpStream| {
            let _ = st.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                    MAX_RESPONSE_BYTES + 1
                )
                .as_bytes(),
            );
        });
        let e = client(port)
            .request("POST", "tl_initmain", "", None, T)
            .unwrap_err();
        assert_eq!(e, "response too large");
        // unannounced (close-delimited) body
        let (port, _h) = server(|st: &mut TcpStream| {
            let _ = st.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
            let chunk = vec![b'x'; 1 << 20];
            for _ in 0..9 {
                if st.write_all(&chunk).is_err() {
                    break;
                }
            }
        });
        let e = client(port)
            .request("POST", "tl_initmain", "", None, T)
            .unwrap_err();
        assert_eq!(e, "response too large");
        // exactly at the bound is accepted
        let body = format!("\"{}\"", "y".repeat(MAX_RESPONSE_BYTES - 2));
        assert_eq!(body.len(), MAX_RESPONSE_BYTES);
        let (port, _h) = server(canned("200 OK", "application/json", body.as_bytes()));
        let r = client(port)
            .request("POST", "tl_initmain", "", None, T)
            .unwrap();
        assert_eq!(r.body.as_str().map(str::len), Some(MAX_RESPONSE_BYTES - 2));
    }

    #[test]
    fn malformed_endpoints_and_verbs_never_reach_the_network() {
        let mut c = client(1);
        let long = "a".repeat(65);
        for e in ["", "a/b", "../x", "tl x", "tl?x=1", "\u{e9}", long.as_str()] {
            assert_eq!(
                c.request("POST", e, "", None, T).unwrap_err(),
                "listener endpoint malformed",
                "{e:?}"
            );
        }
        assert!(c.request("DELETE", "tl_initmain", "", None, T).is_err());
    }
}
