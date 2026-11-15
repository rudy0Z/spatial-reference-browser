'use strict';

// §B.8.4 — session partition policy (pure).
//
// A spatial node may carry an optional `partition` field selecting an
// isolated Chromium session for its live view:
//   'default'            → the profile's ordinary session (the normal path).
//   'sandbox'            → an in-memory, non-persistent session built on
//                          session.fromPartition('temp:sandbox') — logged-out
//                          localhost/client testing; cookies and storage die
//                          with the process (no `persist:` prefix).
//   'persist:region-<id>' → a per-region persistent partition. Region ids are
//                          validated, so a hostile payload can never select
//                          another app partition (or the chrome's own
//                          CHROME_PARTITION) through a node record.
//
// tab-view.js createTabView consumes the resolution; the sandbox partition is
// created once per process through the same session.fromPartition call the
// spec names.

const SANDBOX_FIELD = 'sandbox';
const DEFAULT_FIELD = 'default';
const SANDBOX_PARTITION = 'temp:sandbox';
// Region partition names: `persist:` prefix keeps storage on disk, keyed to a
// region id the shell generates (uuid-shaped or plain slug — bounded, safe
// charset only; dots/backslashes/colons are refused so a name can never climb
// out of the partitions directory or address another surface).
const REGION_PARTITION_PATTERN = /^persist:region-[0-9a-z][0-9a-z-]{0,63}$/i;

/** Normalize a node record's optional partition field. Unknown, hostile or
 *  oversized values drop to null — the caller then uses the default session.
 *  @returns {'default'|'sandbox'|string|null} */
function normalizePartitionField(value) {
  if (value == null || typeof value !== 'string' || value.length === 0 || value.length > 80) {
    return null;
  }
  const lowered = value.toLowerCase();
  if (lowered === DEFAULT_FIELD) return DEFAULT_FIELD;
  if (lowered === SANDBOX_FIELD) return SANDBOX_FIELD;
  if (REGION_PARTITION_PATTERN.test(lowered)) return lowered;
  return null;
}

/** True when the normalized field selects the isolated sandbox session. */
const isSandboxPartition = (value) => normalizePartitionField(value) === SANDBOX_FIELD;

/**
 * Resolve one tab's session partition. The caller passes the tab's private
 * flag too: a private tab's in-memory session wins (the sandbox is also
 * memory-only, but privacy posture outranks the sandbox label — a private
 * tab is never rerouted into the shared sandbox where its storage could
 * co-mingle with other sandbox tabs).
 * @param {string|null} partitionField normalized field (may be null)
 * @param {{ private?: boolean }} [tab]
 * @returns {{ partition: string, persistent: boolean } | null}
 *   null → the caller's normal/private profile session path applies.
 */
function resolveTabPartition(partitionField, tab = {}) {
  const field = normalizePartitionField(partitionField);
  if (!field || field === DEFAULT_FIELD) return null;
  if (tab.private === true) return null;
  if (field === SANDBOX_FIELD) return { partition: SANDBOX_PARTITION, persistent: false };
  return { partition: field, persistent: true };
}

module.exports = {
  SANDBOX_FIELD,
  DEFAULT_FIELD,
  SANDBOX_PARTITION,
  REGION_PARTITION_PATTERN,
  normalizePartitionField,
  isSandboxPartition,
  resolveTabPartition,
};
