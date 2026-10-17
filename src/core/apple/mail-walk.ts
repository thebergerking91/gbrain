/** Pagination belongs to a particular enumeration, never just a timestamp suffix. */
import { appleOwnerDigest } from './loops-status.ts';
import type { AppleSourceConfig, AppleSourceState } from './types.ts';

export function beginMailWalk(state: AppleSourceState, cfg: AppleSourceConfig, windowStart: Date, full: boolean, reread: boolean,
  incrementalSince: Date): NonNullable<AppleSourceState['mail']['walk']> {
  const scope = JSON.stringify([cfg.mailDays, [...cfg.mailMailboxes].sort(), appleOwnerDigest(cfg.mailOwnerAddresses)]);
  const old = state.mail.walk;
  const purpose = full ? 'full' : old?.purpose === 'full' ? 'full' : reread ? 'reread' : 'incremental';
  const key = `${purpose}:${scope}`;
  if (old?.key === key) return old;
  delete state.mail.resume_from;
  delete state.mail.resume_id;
  return state.mail.walk = { key, purpose, since: (purpose === 'incremental' ? incrementalSince : windowStart).toISOString(), seen: [] };
}
