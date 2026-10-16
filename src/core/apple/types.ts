/**
 * Apple connector types (issue #6855). macOS-only, read-only: Calendar
 * (EventKit), Contacts (Contacts.framework), Mail (Mail.app scripting).
 *
 * Contract shared with src/core/apple/readers/* (READERS builder).
 */
import type { AppleReaderErrorCode } from './readers/errors.ts';

export { AppleReaderError } from './readers/errors.ts';
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
    signal?: AbortSignal;
  }): Promise<AppleMailMessage[]>;
  probe(
    service: AppleService,
  ): Promise<{ ok: true } | { ok: false; code: AppleReaderErrorCode; fix: string }>;
}

/** Cursor / state file persisted next to the managed clone. */
export interface AppleSourceState {
  version: 1;
  calendar: {
    window?: { from: string; to: string };
    hashes: Record<string, string>;
  };
  contacts: { hashes: Record<string, string> };
  mail: { since?: string; hashes: Record<string, string> };
  /** ItemHoldsState (connectors/item-holds.ts); opaque here so types.ts stays dependency-free. */
  item_holds: unknown;
  last_probe?: Record<string, { ok: boolean; at: string; code?: string }>;
  last_full_at?: string;
}
