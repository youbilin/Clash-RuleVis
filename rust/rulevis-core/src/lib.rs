pub mod defaults;
pub mod generator;
pub mod links;
pub mod model;
pub mod resolve;

pub use defaults::{
    create_builtin_exits, ensure_workspace_shape, normalize_manual_sources,
    prune_unavailable_exit_members, MANUAL_SOURCE_NAME, MANUAL_SOURCE_NOTE,
};
pub use generator::{generate_config, GenerateOptions, GeneratedConfig};
pub use links::{
    parse_share_link, share_node_display_name, share_node_to_proxy, NodeLinkError, ParsedShareNode,
};
pub use model::*;
pub use resolve::{
    node_display_name, provider_slug, resolve_exit, ExitResolution, MissingRef, ResolveContext,
};
