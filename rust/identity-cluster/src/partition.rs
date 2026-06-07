//! Hash-partitioning for Option B (D4) — the CRITICAL gate-1 mechanism.
//!
//! GATE 1 (NO global id-map): we partition by `hash(canonical_id) % K` DIRECTLY
//! on the string id. There is NO global `canonical_id -> dense_int` map and NO
//! global node HashMap. The string id IS the node identity AND (since cluster_id
//! = lexicographic min) the label value. Peak resident state is one partition's
//! labels (O(N/K)), proven by the K-variation regression (K^ -> RSS v). A global
//! map would be K-INVARIANT and would fail that test — the D4-rollback trigger.
//!
//! Edge spill (PSW/GraphChi disk message-passing): every SAME_AS edge (a,b) is
//! written to BOTH endpoint partitions' on-disk edge files, as the local
//! endpoint's id followed by the neighbor's id. So when partition P is resident,
//! every edge incident to a P-node is locally visible WITHOUT loading any other
//! partition. Edges live on DISK; only one partition is materialised at a time.

use std::fs::File;
use std::io::{BufWriter, Write};

/// FNV-1a 64-bit over the id's UTF-8 bytes. Dependency-free, deterministic, and
/// well-distributed for short ASCII ids. This hash is a PRIVATE partitioning
/// concern only; it does NOT influence cluster_id (= lexicographic min) and is
/// unrelated to the serve-time meta-NN.db xxhash64 router (that is PR-C3's
/// identity-graph.bin sharding — out of PR-C2 scope).
#[inline]
pub fn partition_of(id: &str, k: usize) -> usize {
    let mut h: u64 = 0xcbf29ce484222325;
    for &byte in id.as_bytes() {
        h ^= byte as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    (h % (k as u64)) as usize
}

/// Per-partition edge spill writers. Each partition gets a length-prefixed binary
/// edge file: repeated `[u16 local_len][local bytes][u16 nb_len][nb bytes]`.
/// One writer open per partition (K file handles); rows are streamed, never
/// buffered whole. Singleton/pair data shape keeps these files small.
pub struct EdgeSpill {
    writers: Vec<BufWriter<File>>,
    paths: Vec<String>,
    counts: Vec<u64>,
    k: usize,
}

impl EdgeSpill {
    pub fn new(work_dir: &str, k: usize) -> Result<Self, String> {
        std::fs::create_dir_all(work_dir).map_err(|e| format!("mkdir {}: {}", work_dir, e))?;
        let mut writers = Vec::with_capacity(k);
        let mut paths = Vec::with_capacity(k);
        for p in 0..k {
            let path = format!("{}/edges-{:04}.bin", work_dir, p);
            let f = File::create(&path).map_err(|e| format!("create {}: {}", path, e))?;
            writers.push(BufWriter::new(f));
            paths.push(path);
        }
        Ok(Self { writers, paths, counts: vec![0u64; k], k })
    }

    /// Spill one undirected edge to BOTH endpoint partitions (local-first record).
    pub fn add_edge(&mut self, a: &str, b: &str) -> Result<(), String> {
        let pa = partition_of(a, self.k);
        let pb = partition_of(b, self.k);
        self.write_row(pa, a, b)?;
        self.write_row(pb, b, a)?;
        Ok(())
    }

    fn write_row(&mut self, part: usize, local: &str, neighbor: &str) -> Result<(), String> {
        let w = &mut self.writers[part];
        write_str(w, local)?;
        write_str(w, neighbor)?;
        self.counts[part] += 1;
        Ok(())
    }

    /// Flush all writers and return (per-partition edge-row counts, paths).
    pub fn finish(mut self) -> Result<(Vec<u64>, Vec<String>), String> {
        for w in self.writers.iter_mut() {
            w.flush().map_err(|e| format!("flush spill: {}", e))?;
        }
        Ok((self.counts, self.paths))
    }
}

fn write_str<W: Write>(w: &mut W, s: &str) -> Result<(), String> {
    let bytes = s.as_bytes();
    let len = bytes.len().min(u16::MAX as usize) as u16;
    w.write_all(&len.to_le_bytes()).map_err(|e| format!("spill len: {}", e))?;
    w.write_all(&bytes[..len as usize]).map_err(|e| format!("spill str: {}", e))?;
    Ok(())
}

/// Read all `(local, neighbor)` edge rows from one partition's spill file.
/// Returns owned strings for THIS partition only (O(edges-in-partition)).
pub fn read_partition_edges(path: &str) -> Result<Vec<(String, String)>, String> {
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(_) => return Ok(Vec::new()), // an empty partition wrote no file rows
    };
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 2 <= data.len() {
        let (local, ni) = read_str(&data, i)?;
        let (neighbor, nj) = read_str(&data, ni)?;
        out.push((local, neighbor));
        i = nj;
    }
    Ok(out)
}

fn read_str(data: &[u8], at: usize) -> Result<(String, usize), String> {
    if at + 2 > data.len() {
        return Err("truncated spill len".into());
    }
    let len = u16::from_le_bytes([data[at], data[at + 1]]) as usize;
    let start = at + 2;
    let end = start + len;
    if end > data.len() {
        return Err("truncated spill str".into());
    }
    let s = String::from_utf8_lossy(&data[start..end]).to_string();
    Ok((s, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partition_is_deterministic_and_in_range() {
        for k in [16usize, 96, 256] {
            let p1 = partition_of("hf-model--meta--llama-3-8b", k);
            let p2 = partition_of("hf-model--meta--llama-3-8b", k);
            assert_eq!(p1, p2);
            assert!(p1 < k);
        }
    }

    #[test]
    fn edge_spills_to_both_endpoints() {
        let dir = std::env::temp_dir().join("idc_spill_test").to_string_lossy().to_string();
        let _ = std::fs::remove_dir_all(&dir);
        let mut s = EdgeSpill::new(&dir, 96).unwrap();
        s.add_edge("aaa", "zzz").unwrap();
        let (counts, paths) = s.finish().unwrap();
        let total: u64 = counts.iter().sum();
        assert_eq!(total, 2, "one undirected edge -> two spill rows (dual endpoint)");
        let pa = partition_of("aaa", 96);
        let rows = read_partition_edges(&paths[pa]).unwrap();
        assert!(rows.iter().any(|(l, n)| l == "aaa" && n == "zzz"));
    }
}
