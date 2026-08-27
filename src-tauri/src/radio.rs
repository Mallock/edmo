//! The station relay — internet radio, fetched by the app rather than the page.
//!
//! Measured, not assumed: SomaFM answers `403 Forbidden` to any request
//! carrying a browser User-Agent and `200 audio/mpeg` to one that identifies
//! the application. A web page cannot change its User-Agent, so a stream
//! started from the webview can never play. That is not a quirk to work
//! around quietly — it is SomaFM asking third-party players to say who they
//! are, which is a fair thing to ask, so the app says who it is.
//!
//! Everything therefore goes through a loopback relay: the webview asks
//! `http://127.0.0.1:<port>/play?url=…`, this opens the upstream with a
//! proper User-Agent, and copies bytes across. Three problems fall out at
//! once — the block is gone, the response is same-origin so CORS never
//! applies (which means EVERY station can be routed into the audio graph and
//! ducked properly), and an `http://` station stops being mixed content.
//!
//! The port is random and bound to loopback only, the same posture as the
//! bundled inference server.

use std::sync::Mutex;

use futures_util::StreamExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// Who we tell stations we are. Contactable on purpose: a station operator
/// who wants this app to stop should be able to find it.
const USER_AGENT: &str = concat!(
    "EDMissionOperator/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/Mallock/edmo)"
);

#[derive(Default)]
pub struct RadioCtl {
    port: Mutex<Option<u16>>,
}

/// Start the relay if it is not already listening; return its port.
#[tauri::command]
pub async fn radio_relay_port(ctl: tauri::State<'_, RadioCtl>) -> Result<u16, String> {
    if let Some(p) = *ctl.port.lock().unwrap() {
        return Ok(p);
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("could not open the relay: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    *ctl.port.lock().unwrap() = Some(port);

    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((sock, _)) => {
                    tauri::async_runtime::spawn(async move {
                        let _ = serve(sock).await;
                    });
                }
                // The listener itself failing is terminal; a single bad
                // connection is not worth tearing the relay down for.
                Err(_) => break,
            }
        }
    });

    Ok(port)
}

/// Read the request line, pull out `?url=`, and pipe the upstream across.
async fn serve(sock: TcpStream) -> std::io::Result<()> {
    let (read_half, mut write) = sock.into_split();
    let mut lines = BufReader::new(read_half).lines();
    let request = match lines.next_line().await? {
        Some(l) => l,
        None => return Ok(()),
    };
    // Drain the rest of the headers so the client is not left writing.
    while let Some(line) = lines.next_line().await? {
        if line.is_empty() {
            break;
        }
    }

    let target = request
        .split_whitespace()
        .nth(1)
        .and_then(|path| path.split_once("url=").map(|(_, u)| u.to_string()))
        .map(|raw| percent_decode(&raw));

    let url = match target {
        // Only ever reach out to real internet radio: no file://, no gopher,
        // and nothing pointed back at this machine.
        Some(u)
            if (u.starts_with("http://") || u.starts_with("https://"))
                && !u.contains("127.0.0.1")
                && !u.contains("localhost") =>
        {
            u
        }
        _ => {
            let _ = write
                .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                .await;
            return Ok(());
        }
    };

    let client = match reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Ok(()),
    };

    let upstream = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        // Say what happened rather than hanging: the panel shows this.
        Ok(r) => {
            let msg = format!(
                "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nX-Upstream-Status: {}\r\n\r\n",
                r.status().as_u16()
            );
            let _ = write.write_all(msg.as_bytes()).await;
            return Ok(());
        }
        Err(_) => {
            let _ = write
                .write_all(b"HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\n\r\n")
                .await;
            return Ok(());
        }
    };

    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/mpeg")
        .to_string();

    // No Content-Length: a station never ends. Same-origin to the webview, so
    // the CORS header is belt and braces rather than a requirement.
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\n\
         Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    );
    write.write_all(head.as_bytes()).await?;

    let mut stream = upstream.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                // A closed pipe means the commander changed station or shut
                // the radio off — end quietly.
                if write.write_all(&bytes).await.is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    Ok(())
}

/// Minimal percent-decoding — station URLs are the only thing that arrives.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_the_urls_stations_actually_use() {
        assert_eq!(
            percent_decode("https%3A%2F%2Fice1.somafm.com%2Fspacestation-128-mp3"),
            "https://ice1.somafm.com/spacestation-128-mp3"
        );
        // A malformed escape must not eat the rest of the string.
        assert_eq!(percent_decode("http://x/%zz"), "http://x/%zz");
        assert_eq!(percent_decode("http://plain/url"), "http://plain/url");
    }
}
