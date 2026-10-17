/**
 * Apple connector types (issue #6855). macOS-only, read-only: Calendar
 * (EventKit), Contacts (Contacts.framework), Mail (Mail.app scripting).
 *
 * Contract shared with src/core/apple/readers/* (READERS builder).
 */
// No runtime import here: this file is in the PGLite snapshot/migration import closure (via source-config.ts),
// so it stays free of the reader code. `AppleReaderError` lives in ./readers/errors.ts.
import type { AppleReaderErrorCode } from './readers/errors.ts';

export type { AppleReaderErrorCode } from './readers/errors.ts';

export type AppleService = 'calendar' | 'contacts' | 'mail';
export const ALL_APPLE_SERVICES: AppleService[] = ['calendar', 'contacts', 'mail'];
export const DEFAULT_CONTACTS_DIR = 'people';

export interface AppleSourceConfig {
  account: string;
  services: AppleService[];
  historyDays: number;
  futureDays: number;
  calendarIds: string[];
  contactsDir: string;
  mailMailboxes: string[];
  mailDays: number;
  /** Per-run cap on messages read (a_mail_max). */
  mailMax: number;
  dir: string;
}

export interface AppleCalendarEvent {
  id: string;
  calendarId: string;
  calendarTitle: string;
  title: string;
  /** ISO 8601 */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  organizer?: string;
  attendees: { name?: string; email?: string }[];
  status?: string;
  recurring: boolean;
  lastModified?: string;
}

export interface AppleContact {
  id: string;
  givenName?: string;
  familyName?: string;
  nickname?: string;
  organization?: string;
  jobTitle?: string;
  emails: string[];
  phones: string[];
  groups: string[];
  lastModified?: string;
}

export interface AppleMailMessage {
  id: string;
  threadId: string;
  mailbox: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: string;
  /** plain text, capped 20000 chars by the reader */
  body: string;
  read: boolean;
}

/**
 * What a mail reader may return instead of a bare array when it knows the
 * listing is not the whole story. A bare `AppleMailMessage[]` means "complete".
 */
export interface AppleMailListing {
  messages: AppleMailMessage[];
  /** More messages matched than the per-run cap; the OLDEST cap-many are returned, resume from the newest. */
  truncated?: boolean;
  /** Threads with a message that could not be read: present in the account, so never to be swept as deleted. */
  unavailableThreads?: string[];
  /** A message could not even be attributed to a thread: nothing may be swept as deleted this run. */
  incomplete?: boolean;
}

export interface AppleReaders {
  calendar(opts: {
    from: Date;
    to: Date;
    calendarIds: string[];
    signal?: AbortSignal;
  }): Promise<AppleCalendarEvent[]>;
  contacts(opts: { signal?: AbortSignal }): Promise<AppleContact[]>;
  mail(opts: {
    since: Date;
    mailboxes: string[];
    /** Per-run message cap (a_mail_max). */
    max?: number;
    signal?: AbortSignal;
  }): Promise<AppleMailMessage[] | AppleMailListing>;
  probe(
    service: AppleService,
  ): Promise<{ ok: true } | { ok: false; code: AppleReaderErrorCode; fix: string }>;
  /**
   * Show the macOS permission prompt for a service that has not been asked yet
   * (probe reports `permission_not_determined`) without reading any item.
   * Optional so a read-only fake needs no stub; setup skips the request when absent.
   */
  requestAccess?(service: AppleService): Promise<{ ok: true } | { ok: false; code: AppleReaderErrorCode; fix: string }>;
}

/** Cursor / state file persisted next to the managed clone. */
export interface AppleSourceState {
  version: 1;
  calendar: {
    window?: { from: string; to: string };
    hashes: Record<string, string>;
  };
  contacts: { hashes: Record<string, string> };
  mail: {
    /** Start of the mail window the last sweep covered. */
    since?: string;
    hashes: Record<string, string>;
    /** Newest message date read by the last complete run; the next run re-reads a 2-day overlap before it. */
    newest?: string;
    /** Newest message date of a run cut short by a_mail_max; the next run resumes from here. */
    resume_from?: string;
  };
  /** ItemHoldsState (connectors/item-holds.ts); opaque here so types.ts stays dependency-free. */
  item_holds: unknown;
  last_probe?: Record<string, { ok: boolean; at: string; code?: string }>;
  last_full_at?: string;
}
