//! V26.5 Satellite Task Engines (Rust FFI)
//!
//! Five satellite task core computations via N-API:
//! - Search indexing (core + sharded full index)
//! - Relations graph building
//! - Knowledge linker (keyword matching)
//! - Alt linker (Jaccard similarity)
//! - Mesh graph (unified graph construction)
//!
//! V26.5: Each function has a `_from_dir` variant that reads shard files
//! directly via nxvf-core, eliminating JS Buffer transfer bottleneck.

mod search_indexer;
mod relations;
mod knowledge_linker;
mod alt_linker;
mod mesh_graph;

// Re-export all N-API functions
pub use search_indexer::*;
pub use relations::*;
pub use knowledge_linker::*;
pub use alt_linker::*;
pub use mesh_graph::*;
