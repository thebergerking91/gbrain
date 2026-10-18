/**
 * Synthetic Apple Mail for the poison-recovery suites: a mailbox of messages, per-message unreadability, and a reader
 * that behaves like the helper (windowed listing in (date,id) order, `exclude`, `after`, `max`, proven/deferred
 * verdicts, a read by id). No macOS, no Mail.app, no private data; placeholders only.
 */
import type { AppleMailListing, AppleMailMessage, AppleMailTarget, AppleReaders } from '../../src/core/apple/types.ts';

export const OWNER = 'me-example@example.com';
export const NOW = Date.parse('2026-10-16T12:00:00-07:00');
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const dayIso = (daysAgo: number, hour = 9): string => new Date(Date.UTC(2026, 9, 16 - daysAgo, hour, 0, 0)).toISOString();

export function mk(id: string, threadId: string, daysAgo: number, over: Partial<AppleMailMessage> = {}): AppleMailMessage {
  return { id, threadId, mailbox: 'INBOX', subject: `Subject ${threadId}`, from: 'Alice Example <alice-example@example.com>', to: [OWNER], cc: [],
    date: dayIso(daysAgo), body: `Synthetic body of ${id}.`, read: true, automated: false, bulk: false, ...over };
}

// ── Synthetic Mail ───────────────────────────────────────────────────────────

export interface FakeMail {
  /** Every message in the mailbox, readable or not. */
  box: AppleMailMessage[];
  /** Ids Mail cannot produce a body for (the reader proves each unreadable on its own). */
  unreadable: Set<string>;
  /** Threads the reader reports unavailable WITHOUT proof (a failed batch it could not retry). */
  deferred: Set<string>;
  main: Array<{ since: string; after?: { date: string; id: string }; exclude: string[]; max?: number }>;
  byId: AppleMailTarget[][];
  failMain?: Error;
  failById?: Error;
  /** Ignored by the reader when set: every message is reported unavailable and nothing is read (a Mail outage). */
  outage?: boolean;
  /** Reader without `mailMessages` (cannot read by id). */
  noById?: boolean;
  /** Return a budget-exhausted empty slice instead of reading. */
  budgetStop?: boolean;
}
export const fakeMail = (box: AppleMailMessage[] = []): FakeMail => ({ box, unreadable: new Set(), deferred: new Set(), main: [], byId: [] });
const cmp = (a: AppleMailMessage, b: AppleMailMessage): number => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);

export function readersOf(f: FakeMail): AppleReaders {
  const verdict = (selected: AppleMailMessage[]): AppleMailListing => {
    const bad = f.outage ? selected : selected.filter((m) => f.unreadable.has(m.id));
    const deferredThreads = [...new Set(selected.filter((m) => f.deferred.has(m.threadId) && !bad.includes(m)).map((m) => m.threadId))];
    return {
      messages: structuredClone(selected.filter((m) => !bad.includes(m) && !f.deferred.has(m.threadId))),
      unavailableThreads: [...new Set([...bad.map((m) => m.threadId), ...deferredThreads])],
      unavailableMessages: bad.map((m) => ({ id: m.id, date: m.date, threadId: m.threadId })),
      deferredThreads,
    };
  };
  const readers: AppleReaders = {
    async calendar() { return []; },
    async contacts() { return []; },
    async mail(opts) {
      f.main.push({ since: opts.since.toISOString(), ...(opts.after ? { after: opts.after } : {}), exclude: opts.exclude ?? [], max: opts.max });
      if (f.failMain) throw f.failMain;
      if (f.budgetStop) return { messages: [], truncated: true, budgetExhausted: true };
      const excluded = new Set(opts.exclude ?? []);
      const all = f.box.filter((m) => Date.parse(m.date) > opts.since.getTime() && !excluded.has(m.id)
        && (!opts.after || m.date > opts.after.date || (m.date === opts.after.date && m.id > opts.after.id))).sort(cmp);
      const max = opts.max ?? 500;
      return { ...verdict(all.slice(0, max)), truncated: all.length > max };
    },
    async probe() { return { ok: true as const }; },
    async mailMessages(opts) {
      f.byId.push(opts.targets.map((t) => ({ ...t })));
      if (f.failById) throw f.failById;
      const found = opts.targets.flatMap((t) => f.box.filter((m) => m.id === t.id));
      const listing = verdict(found.sort(cmp));
      return { ...listing, targetMissing: opts.targets.filter((t) => !f.box.some((m) => m.id === t.id)).map((t) => t.id) };
    },
  };
  if (f.noById) delete readers.mailMessages;
  return readers;
}

