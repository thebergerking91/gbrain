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
 *  - the circuit breaker judges messages and threads as separate groups, and a held record that is only RE-attempted is
 *    exempt from it (`mailHoldGroup`): a poison message failing again advances its reconsideration and backoff however
 *    many poison messages are held and however quiet or busy the mailbox is, while fresh failures keep the breaker;
 *  - a held thread import is rebuilt only from COMPLETE evidence. Its locator is the remembered (id, date) list, read by
 *    id in bounded batches of one run and rendered once every message is accounted for (read, proven unreadable or gone
 *    upstream); a thread too long for a list (or an unreadable locator) is recovered by a whole-window walk
 *    (`MailHoldPlan.walk`) and cleared only when that walk completes. A partial batch never lands or clears anything.
 */
import type { ConnectorHoldSession } from '../connectors/connector-hold-session.ts';
import { ConnectorItemUnreadableError } from '../connectors/item-holds.ts';
import type { AppleMailListing, AppleMailMessage, AppleMailTarget, AppleUnavailableMessage } from './types.ts';

export const MAIL_THREAD_KEY = 'mail:';
export const MAIL_MESSAGE_KEY = 'mail-message:';
/** Messages per targeted helper call (one batch). */
export const APPLE_MAIL_TARGET_MAX = 25;
/**
 * Messages re-read by id per run (at most RECOVERY_MAX / TARGET_MAX helper calls): a bounded cost. Whole recovery units
 * (one message, or one thread's remembered list) are packed in least-recently-attempted order, so what does not fit is
 * first in line on the next run and nothing starves.
 */
export const APPLE_MAIL_RECOVERY_MAX = 100;
/** Messages remembered per failed thread import, so the thread can be rebuilt without its (old) listing. */
export const APPLE_THREAD_REF_MAX = 100;

export const messageHoldKey = (id: string): string => `${MAIL_MESSAGE_KEY}${id}`;
export const threadHoldKey = (id: string): string => `${MAIL_THREAD_KEY}${id}`;
export const isMessageHoldKey = (key: string): boolean => key.startsWith(MAIL_MESSAGE_KEY);

/**
 * The circuit-breaker group of a hold key: message holds are judged against messages, everything else together. A record
 * that was already held when the run began is only re-attempted (retry-held, backoff, --full): it is not judged by the
 * breaker (a held item failing again is not news of an outage) and keeps counting its reconsideration, unless a judged
 * group tripped the breaker this run.
 */
export const mailHoldGroup = (key: string, heldAtStart = false): string | null => (heldAtStart ? null : isMessageHoldKey(key) ? 'mail-message' : 'item');

/**
 * Locator stored on a failed thread import (`ref`):
 *   `{"m":[[id,date],...]}`  the (id, date) of every message the page is built from (at most APPLE_THREAD_REF_MAX);
 *   `{"w":n}`                a thread of n messages too long for a list: it is recovered by a whole-window walk.
 * A locator is only ever REPLACED by `mergeThreadRef`, which unions what is remembered with what is listed, so a growing
 * thread never keeps a stale shorter list and never keeps a partial one.
 */
export interface ThreadLocator {
  /** The remembered messages (empty when `walk`). */
  targets: AppleMailTarget[];
  /** Recovered by a whole-window walk: oversize, or a locator that cannot be trusted to name every message. */
  walk: boolean;
  /** Messages the locator stands for. */
  size: number;
}

export function parseThreadLocator(ref: string | null | undefined): ThreadLocator {
  const unlocatable: ThreadLocator = { targets: [], walk: true, size: 0 };
  if (!ref) return unlocatable;
  try {
    const parsed = JSON.parse(ref) as { m?: unknown; w?: unknown };
    if (typeof parsed.w === 'number' && Number.isFinite(parsed.w)) return { targets: [], walk: true, size: Math.max(0, Math.floor(parsed.w)) };
    if (!Array.isArray(parsed.m) || parsed.m.length === 0 || parsed.m.length > APPLE_THREAD_REF_MAX) return unlocatable;
    const targets: AppleMailTarget[] = [];
    for (const pair of parsed.m) {
      // One malformed entry makes the whole list untrustworthy: rebuilding from the rest would drop that message silently.
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !pair[0] || typeof pair[1] !== 'string' || !Number.isFinite(Date.parse(pair[1]))) return unlocatable;
      targets.push({ id: pair[0], date: pair[1] });
    }
    return { targets, walk: false, size: targets.length };
  } catch { return unlocatable; }
}

const listRef = (targets: readonly AppleMailTarget[]): string => JSON.stringify({ m: targets.map((t) => [t.id, t.date]) });
const walkRef = (size: number): string => JSON.stringify({ w: size });

/**
 * The locator for a thread import that failed now: the union of what the previous record remembered and the messages of
 * this run, by id. `previous` is the stored record (absent = a first failure). Longer than the bound, or built on a
 * locator that cannot be trusted, it becomes a walk locator; the stale list is never kept.
 */
export function mergeThreadRef(previous: { ref: string | null } | undefined, messages: ReadonlyArray<Pick<AppleMailMessage, 'id' | 'date'>>): string {
  const before = previous ? parseThreadLocator(previous.ref) : null;
  if (before?.walk) return walkRef(Math.max(before.size, messages.length));
  const union = new Map<string, AppleMailTarget>();
  for (const t of before?.targets ?? []) union.set(t.id, t);
  for (const m of messages) union.set(m.id, { id: m.id, date: m.date });
  return union.size > APPLE_THREAD_REF_MAX ? walkRef(union.size) : listRef([...union.values()]);
}

/** The locator of a thread seen for the first time (no record). */
export const encodeThreadRef = (messages: ReadonlyArray<Pick<AppleMailMessage, 'id' | 'date'>>): string => mergeThreadRef(undefined, messages);

/** Writes the sweep's merged locators into the finished holds (a record that survived the run keeps its newest locator). */
export function applyThreadRefs(state: unknown, refs: ReadonlyMap<string, string>): void {
  const items = (state as { items?: Record<string, { ref: string | null }> } | null)?.items;
  if (!items) return;
  for (const [key, ref] of refs) if (items[key]) items[key]!.ref = ref;
}

/** One re-read: a held message, or a thread's remembered messages. Whole units only, so a thread is never half-read. */
export interface RecoveryUnit {
  key: string;
  kind: 'message' | 'thread';
  targets: AppleMailTarget[];
  /** Least recently attempted first (persisted `last_failed_at`), so the order rotates as units are re-attempted. */
  order: string;
}

export interface MailHoldPlan {
  /** Held message ids this run must not read. */
  exclude: string[];
  /** What is due for a re-read by id, least recently attempted first. */
  units: RecoveryUnit[];
  /** A due record no list can rebuild (oversize or unreadable locator): this run needs a whole-window recovery walk. */
  walk: boolean;
}

/** What the sweep must act on before it reads: which held messages to skip and which to re-read wherever they are. */
export function planMailHolds(holds: ConnectorHoldSession): MailHoldPlan {
  const exclude: string[] = [];
  const units: RecoveryUnit[] = [];
  let walk = false;
  for (const record of Object.values(holds.holds.initial().items)) {
    if (isMessageHoldKey(record.key)) {
      if (record.state !== 'held') continue;
      const id = record.key.slice(MAIL_MESSAGE_KEY.length);
      if (!holds.holds.shouldAttempt(record.key)) { exclude.push(id); continue; }
      const date = record.meta.upstream_at;
      if (date && Number.isFinite(Date.parse(date))) units.push({ key: record.key, kind: 'message', targets: [{ id, date }], order: record.last_failed_at });
      else walk = true; // no usable date: only a window read can reach it
    } else if (record.key.startsWith(MAIL_THREAD_KEY)) {
      // A failing thread import (not yet held) is re-attempted too: its cursor pin only re-reads the main slice.
      if (record.state !== 'failing' && !holds.holds.shouldAttempt(record.key)) continue;
      const locator = parseThreadLocator(record.ref);
      if (locator.walk) { if (record.state === 'held') walk = true; continue; }
      units.push({ key: record.key, kind: 'thread', targets: locator.targets, order: record.last_failed_at });
    }
  }
  units.sort((a, b) => a.order.localeCompare(b.order) || a.key.localeCompare(b.key));
  return { exclude, units, walk };
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
  /** Messages a targeted read found gone upstream (deleted or moved): they no longer need to be part of any rebuilt thread. */
  readonly gone = new Set<string>();
  /** Messages proven unreadable this run: accounted for by their message hold, so a thread can be rebuilt without them. */
  readonly unreadable = new Set<string>();

  constructor(private readonly holds: ConnectorHoldSession, private readonly log: (msg: string) => void) {}

  /** Counts one proven-unreadable message; a first-time failure pins the cursor, a re-attempt of a message held at start does not. */
  async fail(m: AppleUnavailableMessage): Promise<void> {
    const { holds } = this;
    const key = messageHoldKey(m.id);
    this.failedThreads.add(m.threadId);
    this.unreadable.add(m.id);
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

  // Targeted re-read of what is due and was not already part of this run's listing. Whole units are packed (a thread is
  // read completely or not at all this run) within the per-run budget, least recently attempted first.
  const seen = new Set<string>([...listing.messages.map((m) => m.id), ...proven.map((m) => m.id)]);
  const wanted = new Map<string, AppleMailTarget>();
  const chosen: Array<{ unit: RecoveryUnit; need: AppleMailTarget[] }> = [];
  for (const unit of plan.units) {
    const need = unit.targets.filter((t) => !seen.has(t.id));
    if (need.length === 0) continue;
    const fresh = need.filter((t) => !wanted.has(t.id));
    if (wanted.size + fresh.length > APPLE_MAIL_RECOVERY_MAX) continue; // first in line on the next run
    for (const t of fresh) wanted.set(t.id, t);
    chosen.push({ unit, need });
  }
  if (wanted.size === 0) return run;
  if (!input.readTargets) {
    log(`[apple] ${wanted.size} held mail message(s) are due for a re-read, but this reader cannot read a message by id; they stay held`);
    return run;
  }
  const read = new Map<string, AppleMailMessage>();
  const batches: AppleMailTarget[][] = [];
  const all = [...wanted.values()];
  for (let i = 0; i < all.length; i += APPLE_MAIL_TARGET_MAX) batches.push(all.slice(i, i + APPLE_MAIL_TARGET_MAX));
  const unavailable = new Map<string, AppleUnavailableMessage>();
  try {
    for (const targets of batches) {
      const result = await input.readTargets({ mailboxes: input.mailboxes, targets, ...(input.signal ? { signal: input.signal } : {}) });
      for (const m of result.messages) read.set(m.id, m);
      for (const m of result.unavailableMessages ?? []) unavailable.set(m.id, m);
      for (const id of result.targetMissing ?? []) run.gone.add(id);
    }
  } catch (e) {
    if (input.signal?.aborted) throw e;
    // A targeted read that fails or times out is a SOURCE problem: not an item failure, not a hold. Whatever the earlier
    // batches resolved is kept below; a unit that is not completely resolved is not used at all.
    log(`[apple] re-reading held mail messages failed (${e instanceof Error ? e.message : String(e)}); they stay held`);
    run.readFailed = true;
  }
  const resolved = (id: string): boolean => read.has(id) || unavailable.has(id) || run.gone.has(id);
  // Units fully resolved by the batches (or already in the listing) may feed rendering; a half-read thread feeds nothing.
  const usable = new Set<string>();
  for (const { unit, need } of chosen) if (need.every((t) => resolved(t.id))) for (const t of unit.targets) usable.add(t.id);
  run.extra = [...read.values()].filter((m) => usable.has(m.id));
  for (const m of unavailable.values()) await run.fail(m);
  for (const id of run.gone) {
    // Deleted or moved upstream: nothing left to read, so nothing left to hold.
    const key = messageHoldKey(id);
    if (holds.holds.record(key)) { holds.shouldAttempt(key); holds.drop(key); run.cleared.add(key); }
  }
  // A thread whose every remembered message is gone upstream has nothing left to rebuild.
  for (const unit of plan.units) {
    if (unit.kind === 'thread' && unit.targets.every((t) => run.gone.has(t.id))) { holds.shouldAttempt(unit.key); holds.drop(unit.key); }
  }
  // Targets the helper could not resolve (batch failed, vanished) stay held and untouched; nothing is counted.
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
