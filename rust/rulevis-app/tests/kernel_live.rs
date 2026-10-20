use rulevis_app::kernel::Kernel;
use rulevis_app::live::LiveAggregator;

#[test]
#[ignore = "requires a running Clash Verge / mihomo controller"]
fn discovers_real_controller_and_builds_live_snapshot() {
    let dir = std::env::temp_dir().join(format!("clash-rulevis-kernel-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut kernel = Kernel::load(&dir);
    kernel.discover(true);
    let status = kernel.status();
    assert!(
        status.connected,
        "kernel should be reachable: {:?}",
        status.error
    );
    let connections = kernel.connections().expect("connections endpoint");
    let proxies = kernel.proxies().expect("proxies endpoint");
    let rules = kernel.rules().expect("rules endpoint");
    let mut live = LiveAggregator::new(kernel.status());
    live.poll(&mut kernel, 5);
    let snapshot = live.snapshot();
    println!(
        "kernel={:?} transport={:?} connections={} proxies={} rules={} domains={} active={}",
        status.version,
        status.transport,
        connections.connections.len(),
        proxies.proxies.len(),
        rules.rules.len(),
        snapshot.stats.domains,
        snapshot.stats.active_connections
    );
    assert!(!snapshot.connections.is_empty() || snapshot.stats.domains == 0);
    let _ = std::fs::remove_dir_all(dir);
}
