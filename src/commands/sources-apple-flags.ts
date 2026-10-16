/**
 * `sources add --kind apple` flag validation (#6855), shared by the legacy
 * parser (sources.ts, exit 2) and the connected-source parser
 * (sources-lifecycle-args.ts, operation contract) so both accept exactly the
 * same values. Pure: no engine, no filesystem, no platform probe.
 *
 * Privacy posture: an unknown or empty `--services` entry is a coded error,
 * never "all services" (Mail and Contacts are private local data).
 */
import {
  APPLE_DEFAULT_ACCOUNT,
  APPLE_FUTURE_DAYS_MAX,
  APPLE_HISTORY_DAYS_MAX,
  APPLE_MAIL_DAYS_MAX,
  parseContactsDir,
} from '../core/apple/source-config.ts';
import { ALL_APPLE_SERVICES, type AppleService } from '../core/apple/types.ts';
import type { AppleAddOptions } from '../core/apple/source-add-config.ts';

/** Flags that configure an apple source and are meaningless on any other kind. */
export const APPLE_ONLY_FLAGS = ['calendar-ids', 'mail-mailboxes', 'mail-days'] as const;
/** Flags google and apple share (each kind validates them its own way). */
export const APPLE_SHARED_FLAGS = ['account', 'services', 'history-days', 'future-days', 'contacts-dir'] as const;

export class AppleAddFlagError extends Error {
  constructor(public code: 'unknown_service' | 'empty_services' | 'invalid_value', message: string, public suggestion: string) {
    super(message);
    this.name = 'AppleAddFlagError';
  }
}

export interface AppleAddRaw {
  services?: string;
  account?: string;
  historyDays?: string | number;
  futureDays?: string | number;
  calendarIds?: string;
  contactsDir?: string;
  mailMailboxes?: string;
  mailDays?: string | number;
  dir: string;
}

const CALENDAR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:%+#@/=-]{0,254}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function tokens(raw: string): string[] {
  return [...new Set(raw.split(',').map((t) => t.trim()).filter(Boolean))];
}

function boundedInt(flag: string, raw: string | number, max: number): number {
  const n = typeof raw === 'number' ? raw : /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new AppleAddFlagError('invalid_value', `--${flag} must be a whole number between 1 and ${max}.`,
      `Pass --${flag} as a whole number of days from 1 to ${max}.`);
  }
  return n;
}

/** The services a `--services` csv names, validated. */
export function parseAppleServicesFlag(raw: string): AppleService[] {
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) {
    throw new AppleAddFlagError('empty_services', '--services needs at least one service.',
      `Pass --services as a comma-separated subset of ${ALL_APPLE_SERVICES.join(',')}, or omit it to sync all three.`);
  }
  const bad = parts.filter((p) => !(ALL_APPLE_SERVICES as readonly string[]).includes(p));
  if (bad.length > 0) {
    throw new AppleAddFlagError('unknown_service', `Unknown Apple service: ${bad.join(', ')}.`,
      `Valid services are ${ALL_APPLE_SERVICES.join(', ')}. Nothing was registered; an unknown name is never widened to "all services".`);
  }
  const uniq = new Set(parts);
  return ALL_APPLE_SERVICES.filter((s) => uniq.has(s));
}

/** Validate raw flag values into the typed `AddSourceOpts.apple` payload. */
export function buildAppleAddOptions(raw: AppleAddRaw): AppleAddOptions {
  const services = raw.services === undefined ? [...ALL_APPLE_SERVICES] : parseAppleServicesFlag(raw.services);
  const account = raw.account === undefined ? undefined : raw.account.trim().replace(/\s+/g, ' ');
  if (account !== undefined && (account.length === 0 || account.length > 64 || CONTROL_RE.test(account))) {
    throw new AppleAddFlagError('invalid_value', '--account must be a short label (1-64 printable characters).',
      `Pass --account as a free-form label such as "personal"; it names the Apple account on this Mac and defaults to "${APPLE_DEFAULT_ACCOUNT}". It is never a credential.`);
  }
  const opts: AppleAddOptions = { services, dir: raw.dir };
  if (account !== undefined) opts.account = account;
  if (raw.historyDays !== undefined) opts.historyDays = boundedInt('history-days', raw.historyDays, APPLE_HISTORY_DAYS_MAX);
  if (raw.futureDays !== undefined) opts.futureDays = boundedInt('future-days', raw.futureDays, APPLE_FUTURE_DAYS_MAX);
  if (raw.mailDays !== undefined) opts.mailDays = boundedInt('mail-days', raw.mailDays, APPLE_MAIL_DAYS_MAX);
  if (raw.calendarIds !== undefined) {
    const ids = tokens(raw.calendarIds);
    if (ids.length === 0 || ids.some((id) => !CALENDAR_ID_RE.test(id))) {
      throw new AppleAddFlagError('invalid_value', '--calendar-ids needs a comma-separated list of calendar ids.',
        'List calendar ids with: gbrain apple services <source> after setup, or omit --calendar-ids to sync every calendar.');
    }
    opts.calendarIds = ids;
  }
  if (raw.contactsDir !== undefined) {
    const dir = parseContactsDir(raw.contactsDir);
    if (!dir) {
      throw new AppleAddFlagError('invalid_value', '--contacts-dir must be a relative directory of lower-case segments.',
        'Pass --contacts-dir as one or more segments of a-z, 0-9, - and _ (e.g. --contacts-dir contacts); it is relative to the source directory.');
    }
    opts.contactsDir = dir;
  }
  if (raw.mailMailboxes !== undefined) {
    const boxes = tokens(raw.mailMailboxes);
    if (boxes.length === 0 || boxes.some((b) => b.length > 128 || CONTROL_RE.test(b))) {
      throw new AppleAddFlagError('invalid_value', '--mail-mailboxes needs a comma-separated list of mailbox names.',
        'Pass --mail-mailboxes as names such as INBOX,Sent (the default); a name with spaces is allowed.');
    }
    opts.mailMailboxes = boxes;
  }
  return opts;
}

/** A warning (never a refusal): registering on a non-macOS host works, syncing will not. */
export function appleAddPlatformWarning(platform: string = process.platform): string | null {
  return platform === 'darwin' ? null
    : 'Warning: the Apple connector reads Calendar, Contacts and Mail through macOS and only syncs on a Mac. This source is registered, but a sync on this host will report unsupported_platform.';
}
