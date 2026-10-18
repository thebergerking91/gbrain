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
  /**
   * Explicit mailbox-owner addresses (a_mail_owner_addresses): lower-case bare addresses. They alone decide
   * which messages are the owner's for open-loop tracking; the account label and Sent-mailbox membership never do.
   */
  mailOwnerAddresses: string[];
  /**
   * a_loops_extract_consent (default false): the owner agreed that Mail thread text may go to the configured
   * chat provider for commitment/decision extraction. Deterministic unanswered tracking never needs it.
   */
  loopsExtractConsent: boolean;
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
  /** The helper's header verdict: RFC 3834 Auto-Submitted (not "no") or a text/calendar part. Machine mail neither opens nor closes a loop. Absent = the reader did not classify. */
  automated?: boolean;
  /** The helper's header verdict: List-Unsubscribe, List-Id, Precedence bulk/list/junk or a no-reply Reply-To. Bulk mail owes no reply. */
  bulk?: boolean;
}

/**
 * What a mail reader may return instead of a bare array when it knows the
 * listing is not the whole story. A bare `AppleMailMessage[]` means "complete".
 */
export interface AppleMailListing {
  messages: AppleMailMessage[];
  /** More messages matched than the per-run cap; the OLDEST cap-many are returned, resume from the newest. */
  truncated?: boolean;
  /** `truncated` because the helper's body-read time budget ran out (slow Mail bodies), not because of the cap. */
  budgetExhausted?: boolean;
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
    max?: number;
    /** Exclusive stable cursor; used with `since` at date-1ms for tied timestamps. */
    after?: { date: string; id: string };
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

/** One grace-held thread (the Google shape: the loop its last detection would open at `due_ms`). */
export interface AppleLoopGraceHold {
  due_ms: number;
  slug: string | null;
  /** Newest message id of the page the spec was computed from. */
  rev: string | null;
  spec: {
    loopType: 'unanswered_inbound' | 'unanswered_outbound';
    counterpartyEmail: string;
    summary: string;
    evidence: Array<{ message_id?: string; page_slug?: string; quote?: string }>;
    lastActivityMs: number;
    openedMs: number;
  } | null;
}

/** One Mail message as open-loop tracking keeps it (bounded text; direction is decided by the owner addresses at detection time). */
export interface AppleLoopMessage {
  id: string;
  /** Lower-case bare sender address. */
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  ms: number;
  /** Reader header verdicts; undefined = unclassified, which refuses the thread (fail closed). */
  auto?: boolean;
  bulk?: boolean;
  /** Quote-trimmed body, capped; a question mark past the cap is kept as a trailing "?". */
  body: string;
}

export interface AppleMailLoopsState {
  /** Bounded recent-thread diagnostic cache. Detection/recovery use complete evidence on durable pages, never this cache. */
  threads?: Record<string, AppleLoopMessage[]>;
  /** Digest of the owner addresses the stored loops were computed for. */
  digest?: string;
  /** The whole mail window must be re-read after identity changes or coverage gaps; cleared only by clean recovery. */
  reread?: boolean;
  /** Finish time of the last run that detected loops on the whole mail listing with nothing partial; the only freshness stamp. */
  complete_at?: string;
  /** Legacy extraction marker, retained when reading old checkpoints; never a catch-up completion authority. */
  extract_seen?: boolean;
  /** Known unreadable/failed threads, cleared only by successful observed recovery, never an empty listing. */
  pending_threads?: string[];
  /** Open deterministic rows require reconciliation under the new owner set. Manual dispositions are retained. */
  identity_reconcile?: boolean;
  /** Unattributed unreadability requires a nonempty complete window walk before claiming coverage again. */
  coverage_gap?: boolean;
  loop_grace_holds?: Record<string, AppleLoopGraceHold>;
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
    /** Message date at the current capped-read boundary. */
    resume_from?: string;
    /** Stable message id at that timestamp, to paginate timestamp ties without repeating them. */
    resume_id?: string;
    /** Stable enumeration scope/purpose. A suffix cannot stand in for a different full/identity walk. */
    walk?: { key: string; since: string; purpose: 'full' | 'reread' | 'incremental'; seen: string[] };
  };
  /** ItemHoldsState (connectors/item-holds.ts); opaque here so types.ts stays dependency-free. */
  item_holds: unknown;
  /** Open-loop tracking over Mail (src/core/apple/loops.ts); absent until a run had owner addresses. */
  mail_loops?: AppleMailLoopsState;
  last_probe?: Record<string, { ok: boolean; at: string; code?: string }>;
  last_full_at?: string;
}
