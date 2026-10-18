/** Pagination belongs to a particular enumeration, never just a timestamp suffix. */
import { appleOwnerDigest } from './loops-status.ts';
import type { AppleSourceConfig, AppleSourceState } from './types.ts';

export function beginMailWalk(state: AppleSourceState, cfg: AppleSourceConfig, windowStart: Date, full: boolean, reread: boolean,
  incrementalSince: Date, recover = false, nowIso = new Date().toISOString()): NonNullable<AppleSourceState['mail']['walk']> {
  const scope = JSON.stringify([cfg.mailDays, [...cfg.mailMailboxes].sort(), appleOwnerDigest(cfg.mailOwnerAddresses)]);
  const old = state.mail.walk;
  // A hold-recovery walk (`recover`) is a whole-window re-read like an identity reread; it removes nothing. Once begun it
  // runs to completion even after the hold that asked for it is gone, never restarting as an incremental read.
  const recovering = recover || (old?.recover !== undefined && old.purpose !== 'incremental');
  const purpose = full ? 'full' : old?.purpose === 'full' ? 'full' : reread || recovering ? 'reread' : 'incremental';
  const key = `${purpose}:${scope}`;
  let walk = old;
  if (old?.key !== key) {
    delete state.mail.resume_from;
    delete state.mail.resume_id;
    walk = state.mail.walk = { key, purpose, since: (purpose === 'incremental' ? incrementalSince : windowStart).toISOString(), seen: [] };
  }
  if (walk && (recovering || purpose === 'full')) walk.recover ??= nowIso;
  return walk!;
}
