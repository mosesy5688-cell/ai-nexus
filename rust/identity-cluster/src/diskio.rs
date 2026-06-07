//! On-disk codecs for label-propagation state (Option B disk message-passing).
//!
//! Labels and messages are length-prefixed `(string, string)` pairs:
//! repeated `[u16 a_len][a bytes][u16 b_len][b bytes]`. Keeping these out of
//! labelprop.rs holds every file under CES 250 (gate 6) and isolates the wire
//! format. All readers tolerate a MISSING file as empty (an unwritten partition
//! inbox is legitimately absent) — never a panic.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Write};

/// Append-mode handle for a per-partition message outbox.
pub fn open_append(path: &str) -> Result<File, String> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open append {}: {}", path, e))
}

/// Persist a partition's label map (node -> label) as length-prefixed pairs.
pub fn write_labels(path: &str, labels: &HashMap<String, String>) -> Result<(), String> {
    let f = File::create(path).map_err(|e| format!("create {}: {}", path, e))?;
    let mut w = BufWriter::new(f);
    for (node, label) in labels {
        write_pair(&mut w, node, label)?;
    }
    w.flush().map_err(|e| format!("labels flush: {}", e))
}

/// Load a partition's label map. Missing file -> empty map.
pub fn read_labels(path: &str) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    for (a, b) in read_pairs(path)? {
        out.insert(a, b);
    }
    Ok(out)
}

/// Write one `(target, proposed_label)` message into an open outbox writer.
pub fn write_msg<W: Write>(w: &mut W, target: &str, proposed: &str) -> Result<(), String> {
    write_pair(w, target, proposed)
}

/// Read all `(target, proposed_label)` messages from an inbox. Missing -> empty.
pub fn read_messages(path: &str) -> Result<Vec<(String, String)>, String> {
    read_pairs(path)
}

fn write_pair<W: Write>(w: &mut W, a: &str, b: &str) -> Result<(), String> {
    for s in [a, b] {
        let bytes = s.as_bytes();
        let len = bytes.len().min(u16::MAX as usize) as u16;
        w.write_all(&len.to_le_bytes()).map_err(|e| format!("pair len: {}", e))?;
        w.write_all(&bytes[..len as usize]).map_err(|e| format!("pair str: {}", e))?;
    }
    Ok(())
}

fn read_pairs(path: &str) -> Result<Vec<(String, String)>, String> {
    let mut data = Vec::new();
    match File::open(path) {
        Ok(mut f) => {
            f.read_to_end(&mut data).map_err(|e| format!("read {}: {}", path, e))?;
        }
        Err(_) => return Ok(Vec::new()),
    }
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 2 <= data.len() {
        let (a, ni) = take_str(&data, i)?;
        let (b, nj) = take_str(&data, ni)?;
        out.push((a, b));
        i = nj;
    }
    Ok(out)
}

fn take_str(data: &[u8], at: usize) -> Result<(String, usize), String> {
    if at + 2 > data.len() {
        return Err("truncated pair len".into());
    }
    let len = u16::from_le_bytes([data[at], data[at + 1]]) as usize;
    let start = at + 2;
    let end = start + len;
    if end > data.len() {
        return Err("truncated pair str".into());
    }
    Ok((String::from_utf8_lossy(&data[start..end]).to_string(), end))
}
