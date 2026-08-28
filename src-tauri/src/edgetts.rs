//! Microsoft Edge's online neural voices, for commanders who want them.
//!
//! The bundled Piper voices are the app's default and its promise: they run on
//! this machine and nothing leaves it. These do not. Every line spoken through
//! this module is sent as text to Microsoft, which is a different bargain
//! entirely — so it is opt-in, off by default, and the settings panel says so
//! in as many words.
//!
//! WHY THIS LIVES IN RUST. The service refuses browsers. Microsoft closed the
//! free endpoint to them in December 2025 by requiring handshake headers that
//! the WebSocket API does not let a page set — `Origin` pinned to the Edge
//! read-aloud extension, and `Sec-WebSocket-Protocol: synthesize`. A webview
//! cannot send either, so the request has to come from native code. This is
//! the same shape as the radio relay next door and for the same reason.
//!
//! WHAT IT COSTS TO GET WRONG. Four things must all be right or the handshake
//! is a flat 403 with no clue in it:
//!
//!   * `Sec-MS-GEC` — SHA-256 of the Windows tick count, rounded down to five
//!     minutes, concatenated with the trusted client token.
//!   * `Sec-MS-GEC-Version` — must be a plausible current Chromium.
//!   * `Origin` — the extension id, which CHANGED when they tightened this.
//!   * `Sec-WebSocket-Protocol: synthesize`.
//!
//! CACHING IS NOT AN OPTIMISATION HERE. The reference implementation caches
//! every phrase it has ever spoken — 21,353 files on this machine — and it is
//! right to: the operator repeats itself constantly ("docking granted, pad
//! four"), the service is rate-limited and undocumented, and a cached line
//! costs nothing and cannot fail. The cache is keyed on everything that
//! changes the audio.
//!
//! AND IT MUST FAIL SOFTLY. This is an undocumented endpoint that Microsoft
//! has already broken twice. Every error path returns Err so the caller falls
//! back to Piper — a line in the wrong voice beats silence, and silence is
//! what a hard failure here would produce.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The token every public client uses. Not a secret; it identifies the tier.
const TRUSTED_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
/// Must look like a current Edge. Stale values are refused.
const CHROMIUM_FULL: &str = "142.0.3595.94";
const HOST: &str = "speech.platform.bing.com";
const PATH: &str = "/consumer/speech/synthesize/readaloud/edge/v1";
/// The read-aloud extension. This id changed when the endpoint was tightened;
/// the old one is a 403.
const ORIGIN: &str = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0";

/// Windows epoch offset in seconds — the tick count is measured from 1601.
const WIN_EPOCH: u64 = 11_644_473_600;

/// `Sec-MS-GEC`: SHA-256 of the tick count (100 ns units, rounded down to a
/// five-minute boundary) followed by the trusted token, uppercase hex.
fn sec_ms_gec() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut ticks = now + WIN_EPOCH;
    ticks -= ticks % 300;
    let hundred_ns = (ticks as u128) * 10_000_000;
    let mut h = Sha256::new();
    h.update(format!("{hundred_ns}{TRUSTED_TOKEN}"));
    format!("{:X}", h.finalize())
}

/// A request id: 32 hex characters, no dashes.
fn request_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut h = Sha256::new();
    h.update(now.to_string());
    h.update(std::process::id().to_string());
    format!("{:x}", h.finalize())[..32].to_string()
}

/// XML-escape, because station names contain ampersands and a broken SSML
/// document is answered with a silent close rather than an error.
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn cache_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("edge-cache"))
}

/// Everything that changes the audio goes in the key, or a rate change would
/// serve the old take back.
fn cache_key(voice: &str, rate: &str, pitch: &str, text: &str) -> String {
    let mut h = Sha256::new();
    h.update(voice);
    h.update(b"\x1f");
    h.update(rate);
    h.update(b"\x1f");
    h.update(pitch);
    h.update(b"\x1f");
    h.update(text);
    format!("{:x}", h.finalize())[..32].to_string()
}

/// Synthesize one line, returning MP3 bytes.
///
/// Cached on disk first: the operator says the same dozen things all evening,
/// and a cached line is instant, free, and immune to the endpoint breaking.
pub async fn speak(
    app: &AppHandle,
    text: &str,
    voice: &str,
    rate_pct: i32,
    pitch_hz: i32,
) -> Result<Vec<u8>, String> {
    let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return Err("empty text".into());
    }
    let rate = format!("{rate_pct:+}%");
    let pitch = format!("{pitch_hz:+}Hz");

    let dir = cache_dir(app);
    let file = dir
        .as_ref()
        .map(|d| d.join(format!("{}.mp3", cache_key(voice, &rate, &pitch, &line))));
    if let Some(p) = &file {
        if let Ok(bytes) = std::fs::read(p) {
            if !bytes.is_empty() {
                return Ok(bytes);
            }
        }
    }

    let audio = synth(&line, voice, &rate, &pitch).await?;
    if let (Some(d), Some(p)) = (&dir, &file) {
        let _ = std::fs::create_dir_all(d);
        let _ = std::fs::write(p, &audio);
    }
    Ok(audio)
}

/// One WebSocket round trip. Hand-rolled rather than pulling in a websocket
/// crate: the exchange is two frames out and a stream of binary frames back,
/// and the handshake is the only fiddly part.
async fn synth(text: &str, voice: &str, rate: &str, pitch: &str) -> Result<Vec<u8>, String> {
    use tokio::net::TcpStream;

    let url_tail = format!(
        "{PATH}?TrustedClientToken={TRUSTED_TOKEN}&Sec-MS-GEC={gec}&Sec-MS-GEC-Version=1-{CHROMIUM_FULL}&ConnectionId={id}",
        gec = sec_ms_gec(),
        id = request_id(),
    );

    let tcp = TcpStream::connect((HOST, 443))
        .await
        .map_err(|e| format!("connect: {e}"))?;
    let connector = native_tls_connector()?;
    let mut stream = connector
        .connect(HOST, tcp)
        .await
        .map_err(|e| format!("tls: {e}"))?;

    // The handshake. `Sec-WebSocket-Key` may be any base64 of 16 bytes; the
    // server's accept value is not checked here because the transport is TLS
    // and the peer is pinned by host.
    let key = "AQIDBAUGBwgJCgsMDQ4PEC==";
    let req = format!(
        "GET {url_tail} HTTP/1.1\r\n\
         Host: {HOST}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: {key}\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Protocol: synthesize\r\n\
         Origin: {ORIGIN}\r\n\
         User-Agent: {UA}\r\n\
         Accept-Language: en-US,en;q=0.9\r\n\
         Pragma: no-cache\r\n\
         Cache-Control: no-cache\r\n\r\n"
    );
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| format!("write handshake: {e}"))?;

    // Read until the end of the response headers.
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        let n = stream
            .read(&mut byte)
            .await
            .map_err(|e| format!("read handshake: {e}"))?;
        if n == 0 {
            return Err("server closed during handshake".into());
        }
        head.push(byte[0]);
        if head.len() > 8192 {
            return Err("handshake response too large".into());
        }
    }
    let head_str = String::from_utf8_lossy(&head);
    if !head_str.starts_with("HTTP/1.1 101") {
        let status = head_str.lines().next().unwrap_or("(no status)");
        return Err(format!("handshake refused: {status}"));
    }

    for frame in [config_frame(), ssml_frame(text, voice, rate, pitch)] {
        write_frame(&mut stream, &frame)
            .await
            .map_err(|e| format!("write: {e}"))?;
    }

    let mut audio = Vec::new();
    loop {
        let payload = read_frame(&mut stream)
            .await
            .map_err(|e| format!("read: {e}"))?;
        match payload {
            Frame::Text(t) => {
                if t.contains("Path:turn.end") {
                    break;
                }
            }
            Frame::Binary(b) => {
                // Each binary message is a two-byte big-endian header length,
                // that many bytes of header, then the audio.
                if b.len() < 2 {
                    continue;
                }
                let hlen = u16::from_be_bytes([b[0], b[1]]) as usize;
                if b.len() >= 2 + hlen {
                    audio.extend_from_slice(&b[2 + hlen..]);
                }
            }
            Frame::Closed => break,
        }
        if audio.len() > 8 * 1024 * 1024 {
            return Err("response too large".into());
        }
    }
    if audio.is_empty() {
        return Err("no audio returned".into());
    }
    Ok(audio)
}

fn config_frame() -> String {
    format!(
        "X-Timestamp:{ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n\
         {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}}}}}",
        ts = http_date(),
    )
}

fn ssml_frame(text: &str, voice: &str, rate: &str, pitch: &str) -> String {
    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-GB'>\
         <voice name='{voice}'><prosody rate='{rate}' pitch='{pitch}'>{text}</prosody></voice></speak>",
        voice = esc(voice),
        text = esc(text),
    );
    format!(
        "X-RequestId:{id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{ts}Z\r\nPath:ssml\r\n\r\n{ssml}",
        id = request_id(),
        ts = http_date(),
    )
}

/// RFC 1123-ish. The service only checks that it parses.
fn http_date() -> String {
    // A fixed-format stamp avoids pulling in a date crate for one header.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    const DOW: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    let (y, mo, d) = civil_from_days(days as i64);
    const MON: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{dow}, {d:02} {mon} {y} {h:02}:{m:02}:{s:02} GMT",
        dow = DOW[(days % 7) as usize],
        mon = MON[(mo - 1) as usize],
    )
}

/// Howard Hinnant's civil-from-days, so the date header needs no crate.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

enum Frame {
    Text(String),
    Binary(Vec<u8>),
    Closed,
}

/// Client frames must be masked (RFC 6455 §5.3).
async fn write_frame<S>(stream: &mut S, text: &str) -> std::io::Result<()>
where
    S: AsyncWriteExt + Unpin,
{
    let payload = text.as_bytes();
    let mut out = vec![0x81u8]; // FIN + text
    let mask = [0x12u8, 0x34, 0x56, 0x78];
    let len = payload.len();
    if len < 126 {
        out.push(0x80 | len as u8);
    } else if len < 65536 {
        out.push(0x80 | 126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    stream.write_all(&out).await
}

async fn read_frame<S>(stream: &mut S) -> std::io::Result<Frame>
where
    S: AsyncReadExt + Unpin,
{
    let mut two = [0u8; 2];
    stream.read_exact(&mut two).await?;
    let opcode = two[0] & 0x0f;
    let mut len = (two[1] & 0x7f) as usize;
    if len == 126 {
        let mut b = [0u8; 2];
        stream.read_exact(&mut b).await?;
        len = u16::from_be_bytes(b) as usize;
    } else if len == 127 {
        let mut b = [0u8; 8];
        stream.read_exact(&mut b).await?;
        len = u64::from_be_bytes(b) as usize;
    }
    // The server never masks.
    let mut payload = vec![0u8; len];
    if len > 0 {
        stream.read_exact(&mut payload).await?;
    }
    Ok(match opcode {
        0x1 => Frame::Text(String::from_utf8_lossy(&payload).into_owned()),
        0x2 => Frame::Binary(payload),
        0x8 => Frame::Closed,
        _ => Frame::Binary(Vec::new()),
    })
}

/// TLS, via the same stack reqwest already links.
fn native_tls_connector() -> Result<tokio_native_tls::TlsConnector, String> {
    let c = native_tls::TlsConnector::builder()
        .build()
        .map_err(|e| format!("tls setup: {e}"))?;
    Ok(tokio_native_tls::TlsConnector::from(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_is_stable_within_a_five_minute_window() {
        // Two calls a second apart must agree, or every line would miss the
        // cache and re-synthesize.
        assert_eq!(sec_ms_gec(), sec_ms_gec());
        assert_eq!(sec_ms_gec().len(), 64);
    }

    #[test]
    fn the_cache_key_changes_with_everything_that_changes_the_audio() {
        let base = cache_key("en-GB-SoniaNeural", "+20%", "+0Hz", "cleared to dock");
        assert_ne!(base, cache_key("en-GB-RyanNeural", "+20%", "+0Hz", "cleared to dock"));
        assert_ne!(base, cache_key("en-GB-SoniaNeural", "+0%", "+0Hz", "cleared to dock"));
        assert_ne!(base, cache_key("en-GB-SoniaNeural", "+20%", "+5Hz", "cleared to dock"));
        assert_ne!(base, cache_key("en-GB-SoniaNeural", "+20%", "+0Hz", "docking denied"));
        assert_eq!(base, cache_key("en-GB-SoniaNeural", "+20%", "+0Hz", "cleared to dock"));
    }

    #[test]
    fn station_names_with_ampersands_do_not_break_the_ssml() {
        let f = ssml_frame("Ridley & Sons", "en-GB-SoniaNeural", "+20%", "+0Hz");
        assert!(f.contains("Ridley &amp; Sons"));
        assert!(!f.contains("Ridley & Sons"));
    }

    /// The real thing, against the live service.
    ///
    /// `#[ignore]` because it needs the network and Microsoft may break the
    /// endpoint at any time — a red suite would then be reporting THEIR
    /// outage as our bug. Run deliberately:
    ///   cargo test --release edgetts -- --ignored --nocapture
    #[test]
    #[ignore]
    fn it_actually_synthesizes_against_the_live_service() {
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let audio = rt
            .block_on(synth(
                "Benyovszky Gateway tower. Stardust Runner, cleared to dock, pad twenty four.",
                "en-GB-SoniaNeural",
                "+20%",
                "+0Hz",
            ))
            .expect("synthesis should succeed");
        // An mp3 frame header, and enough of it to be a real sentence.
        assert!(audio.len() > 8_000, "only {} bytes", audio.len());
        assert!(
            audio.starts_with(&[0xFF]) || audio.starts_with(b"ID3"),
            "not mp3: {:02X?}",
            &audio[..4.min(audio.len())]
        );
        println!("synthesized {} bytes of mp3", audio.len());
    }

    #[test]
    fn the_date_header_looks_like_a_date() {
        let d = http_date();
        assert!(d.ends_with(" GMT"), "{d}");
        assert!(d.len() > 20, "{d}");
    }
}
