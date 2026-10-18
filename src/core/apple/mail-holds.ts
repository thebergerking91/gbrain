/**
 * apple mail-holds — the Apple Mail side of the shared connector item holds (connectors/item-holds.ts).
 *
 * Two kinds of hold exist for Mail, both in the one shared `item_holds` state and both on the shared 3-run
 * threshold, held-at-start skip, `retry-held` request and cursor rules:
 *
 *   `mail:<threadId>`          a thread whose page failed to render or import (existing).
 *   `mail-message:<messageId>` ONE message the reader proved unreadable (Mail.app cannot produce its body). The
 *                              record keeps the stable id (key), the received date (`meta.upstream_at`) and the owning
 *                              thread (`ref`), which is what a targeted re-read, deletion protection and the open-loop
 *                              coverage need after the cursor has moved past the message.
 *
 * Rules (the Google connector's, plus what Mail needs on top):
 *  - only a PROVEN unreadable message is counted (`unavailableMessages`); a thread the reader merely could not
 *    resolve in time (`deferredThreads`), an unattributable message (`incomplete`), a reader/source error, a helper
 *    timeout or a budget truncation is never an item hold and keeps pinning the cursor as before;
 *  - a message counts as a failed run only when the run attempted it; runs 1-3 pin the cursor, a hold that exists when
 *    a run STARTS is excluded from the read (it costs no body time and cannot starve its neighbours) and never pins;
 *  - a held message is re-attempted by `retry-held`, a due transient reconsideration or `sync --full` through a
 *    targeted read by id and date, so it is reachable however old it is;
 *  - while a message hold is outstanding its thread stays live (never removed as deleted) and Mail open-loop coverage
 *    stays incomplete until the message is actually read again;
 *  - the circuit breaker judges messages and threads as separate groups (`mailHoldGroup`).
 */
import type { ConnectorHoldSession } from '../connectors/connector-hold-session.ts';
import { ConnectorItemUnreadableError } from '../connectors/item-holds.ts';
import type { AppleMailListing, AppleMailMessage, AppleMailTarget, AppleUnavailableMessage } from './types.ts';

export const MAIL_THREAD_KEY = 'mail:';
export const MAIL_MESSAGE_KEY = 'mail-message:';
/** Targeted re-reads per run: a bounded cost; the rest stay due and are re-read on the next run. */
export const APPLE_MAIL_TARGET_MAX = 25;
/** Messages remembered per failed thread import, so the thread can be rebuilt without its (old) listing. */
export const APPLE_THREAD_REF_MAX = 100;

export const messageHoldKey = (id: string): string => `${MAIL_MESSAGE_KEY}${id}`;
export const threadHoldKey = (id: string): string => `${MAIL_THREAD_KEY}${id}`;
export const isMessageHoldKey = (key: string): boolean => key.startsWith(MAIL_MESSAGE_KEY);

/** The circuit-breaker group of a hold key: message holds are judged against messages, everything else together. */
export const mailHoldGroup = (key: string): string => (isMessageHoldKey(key) ? 'mail-message' : 'item');

/**
 * Locator stored on a failed thread import: the (id, date) of the messages it was built from. A thread longer than the
 * bound stores none (a partial list would rebuild the page without its older messages); `sync --full` still reaches it.
 */
export function encodeThreadRef(messages: ReadonlyArray<Pick<AppleMailMessage, 'id' | 'date'>>): string | null {
  return messages.length > APPLE_THREAD_REF_MAX ? null : JSON.stringify({ m: messages.map((m) => [m.id, m.date]) });
}

function parseThreadRef(ref: string | null): AppleMailTarget[] {
  if (!ref) return [];
  try {
    const parsed = JSON.parse(ref) as { m?: unknown };
    if (!Array.isArray(parsed.m)) return [];
    return parsed.m.flatMap((pair): AppleMailTarget[] => (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string' && Number.isFinite(Date.parse(pair[1])) ? [{ id: pair[0], date: pair[1] }] : []));
  } catch { return []; }
}

export interface MailHoldPlan {
  /** Held message ids this run must not read. */
  exclude: string[];
  /** Messages to re-read by id and date: held and due (retry-held, due reconsideration, `--full`), plus failed thread imports. */
  targets: AppleMailTarget[];
  /** Thread-import records the targets above rebuild (key -> the message ids they remember). */
  threads: Map<string, string[]>;
}

/** What the sweep must act on before it reads: which held messages to skip and which to re-read wherever they are. */
export function planMailHolds(holds: ConnectorHoldSession): MailHoldPlan {
  const exclude: string[] = [];
  const targets = new Map<string, AppleMailTarget>();
  const threads = new Map<string, string[]>();
  for (const record of Object.values(holds.holds.initial().items)) {
    if (isMessageHoldKey(record.key)) {
      if (record.state !== 'held') continue;
      const id = record.key.slice(MAIL_MESSAGE_KEY.length);
      if (!holds.holds.shouldAttempt(record.key)) { exclude.push(id); continue; }
      const date = record.meta.upstream_at;
      if (date && Number.isFinite(Date.parse(date))) targets.set(id, { id, date });
    } else if (record.key.startsWith(MAIL_THREAD_KEY)) {
      // A failing thread import (not yet held) is re-attempted too: its cursor pin only re-reads the main slice.
      if (record.state === 'failing' || holds.holds.shouldAttempt(record.key)) {
        const remembered = parseThreadRef(record.ref);
        for (const t of remembered) targets.set(t.id, t);
        if (remembered.length > 0) threads.set(record.key, remembered.map((t) => t.id));
      }
    }
  }
  return { exclude, targets: [...targets.values()], threads };
}

/** One run's settlement of the Mail holds; the sweep reads its verdicts, `settleReadMessages` completes it after the pages land. */
export class MailHoldRun {
  /** Messages read by id this run (not part of the cursor's listing); merged for rendering only. */
  extra: AppleMailMessage[] = [];
  /** Something forces the cursor to stay: a first-time unreadable message, an unexplained thread, an unattributable message. */
  pin = false;
  /** Threads with an unreadable message the reader could not resolve (deferred or unexplained): present upstream, never judged. */
  readonly deferred = new Set<string>();
  /** Threads of messages that failed this run. */
  readonly failedThreads = new Set<string>();
  /** Message holds this run settled: recovered (read again and its thread landed) or gone upstream. */
  readonly cleared = new Set<string>();
  /** The targeted read itself failed (source-level): the run is partial but nothing was counted. */
  readFailed = false;

  constructor(private readonly holds: ConnectorHoldSession, private readonly log: (msg: string) => void) {}

  /** Counts one proven-unreadable message; a first-time failure pins the cursor, a re-attempt of a message held at start does not. */
  async fail(m: AppleUnavailableMessage): Promise<void> {
    const { holds } = this;
    const key = messageHoldKey(m.id);
    this.failedThreads.add(m.threadId);
    // Held and not re-admitted: a skip that neither counts nor pins (the reader normally excludes it already).
    if (holds.holds.isHeld(key) && !holds.holds.shouldAttempt(key)) return;
    const wasHeld = holds.isHeld(key);
    holds.shouldAttempt(key);
    const classified = await holds.fail(key, new ConnectorItemUnreadableError('Mail could not produce this message (body unreadable); it is read again by id when retried.'),
      { meta: { upstream_at: m.date }, ref: m.threadId });
    this.log(`[apple] mail message unreadable${wasHeld ? ' (held; re-attempt failed)' : ''}${classified.scope === 'item' ? '' : ' (not counted)'}`);
    if (!wasHeld || classified.scope !== 'item') this.pin = true;
  }

  /**
   * Threads with an outstanding unreadable-message hold after this run: still-held records not settled above, plus this
   * run's failures. They stay live (never removed as deleted) and keep Mail open-loop coverage incomplete.
   */
  blockedThreads(): Set<string> {
    const out = new Set(this.failedThreads);
    for (const record of Object.values(this.holds.holds.initial().items)) {
      if (isMessageHoldKey(record.key) && record.state === 'held' && record.ref && !this.cleared.has(record.key)) out.add(record.ref);
    }
    return out;
  }

  /** Threads whose outstanding message hold this run settled (read again and landed, or gone upstream). */
  clearedThreads(): Set<string> {
    const out = new Set<string>();
    for (const key of this.cleared) { const ref = this.holds.holds.record(key)?.ref; if (ref) out.add(ref); }
    return out;
  }
}

/**
 * Settles the reader's unavailable-message verdicts and re-reads the due targets. Reader errors of the targeted read
 * are source-level and never counted (the run goes on without it); only an abort propagates.
 */
export async function readMailHolds(input: {
  holds: ConnectorHoldSession;
  plan: MailHoldPlan;
  listing: AppleMailListing;
  mailboxes: string[];
  readTargets: ((opts: { mailboxes: string[]; targets: AppleMailTarget[]; signal?: AbortSignal }) => Promise<AppleMailListing>) | undefined;
  signal?: AbortSignal;
  log: (msg: string) => void;
}): Promise<MailHoldRun> {
  const { holds, plan, listing, log } = input;
  const run = new MailHoldRun(holds, log);
  const proven = listing.unavailableMessages ?? [];
  const accounted = new Set(proven.map((m) => m.threadId));
  // A reader without message detail, or a thread it could not explain by a proven message: the conservative behavior.
  for (const t of listing.deferredThreads ?? (listing.unavailableThreads ?? []).filter((x) => !accounted.has(x))) run.deferred.add(t);
  if (run.deferred.size > 0) run.pin = true;
  for (const m of proven) await run.fail(m);

  // Targeted re-read of what is due and was not already part of this run's listing.
  const seen = new Set<string>([...listing.messages.map((m) => m.id), ...proven.map((m) => m.id)]);
  const targets = plan.targets.filter((t) => !seen.has(t.id)).slice(0, APPLE_MAIL_TARGET_MAX);
  if (targets.length === 0) return run;
  if (!input.readTargets) {
    log(`[apple] ${targets.length} held mail message(s) are due for a re-read, but this reader cannot read a message by id; they stay held`);
    return run;
  }
  try {
    const read = await input.readTargets({ mailboxes: input.mailboxes, targets, ...(input.signal ? { signal: input.signal } : {}) });
    run.extra = read.messages;
    for (const m of read.unavailableMessages ?? []) await run.fail(m);
    for (const id of read.targetMissing ?? []) {
      // Deleted or moved upstream: nothing left to read, so nothing left to hold.
      const key = messageHoldKey(id);
      if (holds.holds.record(key)) { holds.shouldAttempt(key); holds.drop(key); run.cleared.add(key); }
    }
    // A thread whose every remembered message is gone upstream has nothing left to rebuild.
    const missing = new Set(read.targetMissing ?? []);
    const asked = new Set(targets.map((t) => t.id));
    for (const [key, ids] of plan.threads) {
      if (ids.every((id) => asked.has(id) && missing.has(id))) { holds.shouldAttempt(key); holds.drop(key); }
    }
    // Targets the helper could not resolve (batch failed, vanished) stay held and untouched; nothing is counted.
  } catch (e) {
    if (input.signal?.aborted) throw e;
    // A targeted read that fails or times out is a SOURCE problem: not an item failure, not a hold.
    log(`[apple] re-reading held mail messages failed (${e instanceof Error ? e.message : String(e)}); they stay held`);
    run.readFailed = true;
  }
  return run;
}

/**
 * After the pages are written: a message read this run clears its record (and counts as a healthy attempt) only when its
 * thread's page landed, so a recovered message whose thread could not be imported stays held and visible. A held
 * message that is not due is left alone (neither counted nor reset).
 */
export function settleReadMessages(holds: ConnectorHoldSession, run: MailHoldRun, messages: readonly AppleMailMessage[], notLanded: ReadonlySet<string>): void {
  for (const m of messages) {
    const key = messageHoldKey(m.id);
    const record = holds.holds.record(key);
    if (record?.state === 'held' && !holds.holds.shouldAttempt(key)) continue;
    if (notLanded.has(m.threadId)) continue;
    if (record) { holds.shouldAttempt(key); run.cleared.add(key); }
    holds.succeed(key);
  }
}
