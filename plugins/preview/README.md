# DZ23 Studio Preview

## Capacity modes

`capacityMode: 'single-process'` is restricted to local development and may use the in-memory governor. It does not provide a cluster-wide quota.

`capacityMode: 'team'` and `capacityMode: 'edge'` require an injected `DistributedCapacityGovernor` backed by a distributed, atomic store. Its admission, heartbeat, release, snapshot and takeover operations expose one strongly consistent lease view. The plugin rejects a missing governor, a governor without takeover and `MemoryCapacityGovernor` in those modes. Enabling the isolated supervisor selects `edge` by default. The edge overlay obtains the PostgreSQL governor published by `@dz23-studio/storage-postgres`; absence is a boot failure.

Preview leases use `ownerId = preview:<previewId>`. On a single-active process restart, the service performs compare-and-swap takeover of the exact existing lease and rotates its fencing token before controlling the runtime. A stale claimant cannot heartbeat or release the new generation. An active record without a lease acquires a fresh bundle; a mismatched or duplicate owner lease fails boot closed.

The current storage backend deliberately allows one Harness writer for each domain, so this proves safe restart/failover, not active-active Preview. Multi-replica operation remains unsupported until the supervisor also validates the fencing token on every runtime operation.

## Cleanup and reconciliation

A runtime remains capacity-accounted while it is `STOPPING`, including after the public preview TTL expires. The reaper heartbeats that quarantine lease before expiring stale leases and consults `listManaged` before considering cleanup complete.

An ambiguous `start` failure triggers inventory lookup by `previewId`. Capacity is released only when inventory confirms absence or when an identified runtime is stopped successfully. If runtime cleanup remains unconfirmed, the record remains `STOPPING` and its capacity stays quarantined.

If the capacity backend cannot release a lease, the record remains `STOPPING` with `CAPACITY_RELEASE_PENDING` in `failure_code`. Reaper and boot reconciliation retry the release. Terminal state is written only after the governor confirms that no owner lease remains.
