# DZ23 Studio Preview

## Capacity modes

`capacityMode: 'single-process'` is restricted to local development and may use the in-memory governor. It does not provide a cluster-wide quota.

`capacityMode: 'team'` and `capacityMode: 'edge'` require an injected `CapacityGovernor` backed by a distributed, atomic store. Its `acquireBundle`, `heartbeat`, `release` and `snapshot` operations must expose one strongly consistent lease view. The plugin rejects a missing governor and rejects `MemoryCapacityGovernor` in those modes. Enabling the isolated supervisor selects `edge` by default; deployments must therefore wire the distributed governor explicitly.

Preview leases use `ownerId = preview:<previewId>`. On restart, the service claims the existing owner lease from the governor snapshot and retains its fencing token instead of allocating a duplicate. Concurrent claimers converge on the oldest valid fencing generation and release duplicate generations.

## Cleanup and reconciliation

A runtime remains capacity-accounted while it is `STOPPING`, including after the public preview TTL expires. The reaper heartbeats that quarantine lease before expiring stale leases and consults `listManaged` before considering cleanup complete.

An ambiguous `start` failure triggers inventory lookup by `previewId`. Capacity is released only when inventory confirms absence or when an identified runtime is stopped successfully. If runtime cleanup remains unconfirmed, the record remains `STOPPING` and its capacity stays quarantined.

If the capacity backend cannot release a lease, the record remains `STOPPING` with `CAPACITY_RELEASE_PENDING` in `failure_code`. Reaper and boot reconciliation retry the release. Terminal state is written only after the governor confirms that no owner lease remains.
