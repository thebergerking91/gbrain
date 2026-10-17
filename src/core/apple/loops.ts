/**
 * apple loops — open-loop (unanswered mail) tracking over Apple Mail threads, reusing the Google engine.
 *
 * Reused unchanged: the zero-LLM thread-state machine (`applyThreadLoopVerdict`: grace windows, turn flips,
 * noise/list/auto-submitted exclusion, mutes, counterparty resolution, `open_loops` upserts), grace-hold
 * recording and settling (`loop-catchup.ts`), the structural extraction eligibility gate and the
 * revision-keyed `loops_extract` enqueue (`loops-enqueue.ts`). Apple-specific, here: the adapter from Mail
 * messages to the detector's thread shape, the owner-identity rule, the consent gates and the freshness rule.
 *
 * Apple policy (also in docs/guides/apple-connect.md):
 *  - Identity: `a_mail_owner_addresses` only. No guessing from the account label or the Sent mailbox.
 *    Without it nothing is detected and the feature is `unavailable: identity_missing` (never "clean").
 *  - Labels: Mail has no Gmail labels, so none are fabricated (no SENT/CATEGORY_* ids). The detector sees
 *    `labelIds: []`; machine/list mail comes from the reader's header verdicts, and a message the reader did
 *    not classify refuses its thread (fail closed; the run is not fresh).
 *  - Gmail label exclusions (`loops.extraction_exclude_labels`) cannot be evaluated on Mail: when set, paid
 *    extraction for Apple is withheld (`excluded_label_unsupported`); deterministic tracking is unaffected.
 *  - Deterministic tracking makes no model call. Paid extraction needs BOTH `loops.extraction_enabled` and the
 *    source's `a_loops_extract_consent`, checked at enqueue and again in the job handler.
 *  - Freshness is stamped only by a Mail sweep that was complete and detected loops in the same run.
 */
import type { BrainEngine } from '../engine.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { trimQuotedReply } from '../google/google-render.ts';
import { asksQuestion, applyThreadLoopVerdict } from '../google/loop-detect.ts';
import { recordGraceVerdict, settleDueGraceHolds, type LoopsEnqueueReport } from '../google/loop-catchup.ts';
import { enqueueLoopsExtraction } from '../google/loops-enqueue.ts';
import { NO_EXCLUSION, excludedLabelTokens } from '../google/loops-exclusion.ts';
import { LOOPS_EXTRACT_WINDOW_DAYS, isLoopsExtractionEnabled, loopExtractionEligibility } from '../google/loops-extract.ts';
import type { GmailMessageMeta, GmailThreadData } from '../google/types.ts';
import { muteRecheckThreads } from '../loops/loops-store.ts';
import { bareAddress, groupMailThreads } from './render.ts';
import { appleLoopsAvailability, appleOwnerDigest } from './loops-status.ts';
import { parseAppleSourceConfig } from './source-config.ts';
import type { AppleLoopMessage, AppleMailLoopsState, AppleMailMessage, AppleSourceConfig, AppleSourceState } from './types.ts';

const DAY_MS = 86_400_000;
export const APPLE_LOOPS_BODY_CAP = 120;
export const APPLE_LOOPS_THREAD_CAP = 100;
export const APPLE_LOOPS_MESSAGES_PER_THREAD = 12;

/** Per-run loop bookkeeping the sweep hands to the post-save enqueue. */
export interface AppleLoopsRun {
  candidates: Array<{ slug: string; threadId: string; newestMs: number }>;
  eligibility: Record<string, number>;
  withheld: Record<string, number>;
  /** Why tracking did not finish; empty = a complete run. */
  gaps: string[];
}

export const newAppleLoopsRun = (): AppleLoopsRun => ({ candidates: [], eligibility: {}, withheld: {}, gaps: [] });

// ── Adapter: Mail message → the detector's message ───────────────────────────

/** A Mail message as the loop state keeps it. Null when it has no usable timestamp. */
export function compactMailMessage(m: AppleMailMessage): AppleLoopMessage | null {
  const ms = Date.parse(m.date);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const full = trimQuotedReply(m.body.replace(/\r\n?/g, '\n'));
  let body = full.replace(/\s+/g, ' ').trim().slice(0, APPLE_LOOPS_BODY_CAP);
  // A question mark beyond the cap still makes the message an ask.
  if (asksQuestion(full) && !asksQuestion(body)) body = `${body.slice(0, APPLE_LOOPS_BODY_CAP - 2)} ?`;
  return {
    id: m.id, from: bareAddress(m.from), to: m.to.map(bareAddress).filter(Boolean), cc: m.cc.map(bareAddress).filter(Boolean),
    subject: m.subject.replace(/\s+/g, ' ').trim().slice(0, 200), ms, body,
    ...(typeof m.automated === 'boolean' ? { auto: m.automated } : {}), ...(typeof m.bulk === 'boolean' ? { bulk: m.bulk } : {}),
  };
}

/**
 * Adapts a thread to the Google detector's input. No Gmail label is invented: `labelIds` is always empty, so
 * direction is the owner-address test alone. Returns null (refuse the thread) when any message lacks the
 * reader's header classification.
 */
export function toLoopThread(threadId: string, messages: readonly AppleLoopMessage[], account: string): GmailThreadData | null {
  if (messages.length === 0 || messages.some((m) => m.auto === undefined || m.bulk === undefined)) return null;
  const metas: GmailMessageMeta[] = [...messages].sort((a, b) => a.ms - b.ms || (a.id < b.id ? -1 : 1)).map((m) => ({
    id: m.id, threadId, from: m.from, fromAddress: m.from, to: m.to, cc: m.cc, subject: m.subject,
    dateIso: new Date(m.ms).toISOString(), internalDateMs: m.ms, labelIds: [],
    listUnsubscribe: m.bulk === true, autoSubmitted: m.auto === true, bodyText: m.body,
  }));
  return { threadId, account, messages: metas };
}

// ── State ────────────────────────────────────────────────────────────────────

/** Merges listed messages over the stored ones (listed wins), bounded; drops threads out of the extraction window. */
export function mergeLoopThreads(state: AppleMailLoopsState, listed: Map<string, AppleLoopMessage[]>, nowMs: number): void {
  const threads = state.threads ??= {};
  for (const [id, fresh] of listed) {
    const byId = new Map((threads[id] ?? []).map((m) => [m.id, m]));
    for (const m of fresh) byId.set(m.id, m);
    threads[id] = [...byId.values()].sort((a, b) => a.ms - b.ms || (a.id < b.id ? -1 : 1)).slice(-APPLE_LOOPS_MESSAGES_PER_THREAD);
  }
  const floor = nowMs - LOOPS_EXTRACT_WINDOW_DAYS * DAY_MS;
  const newest = (id: string): number => threads[id]!.reduce((n, m) => Math.max(n, m.ms), 0);
  for (const id of Object.keys(threads)) if (newest(id) < floor) delete threads[id];
  const ids = Object.keys(threads);
  if (ids.length > APPLE_LOOPS_THREAD_CAP) for (const id of ids.sort((a, b) => newest(a) - newest(b)).slice(0, ids.length - APPLE_LOOPS_THREAD_CAP)) delete threads[id];
}

/**
 * Called before the Mail read. Marks the whole window for re-reading when the owner set changed or extraction
 * was just consented (stored loops/candidates were computed for something else); returns whether this run must
 * read the whole window. The mark is cleared only by a complete run.
 */
export function prepareLoopsState(state: AppleSourceState, cfg: AppleSourceConfig): boolean {
  const loops = state.mail_loops ??= {};
  const digest = appleOwnerDigest(cfg.mailOwnerAddresses);
  if (loops.digest !== digest) { loops.digest = digest; loops.reread = true; delete loops.complete_at; delete loops.threads; delete loops.loop_grace_holds; }
  if (cfg.loopsExtractConsent && loops.extract_seen !== true) loops.reread = true;
  return loops.reread === true;
}

// ── Detection ────────────────────────────────────────────────────────────────

export interface TrackInput {
  engine: BrainEngine;
  sourceId: string;
  cfg: AppleSourceConfig;
  state: AppleSourceState;
  log: (msg: string) => void;
  now: () => number;
  signal?: AbortSignal;
  run: AppleLoopsRun;
  /** The messages this run listed. */
  messages: readonly AppleMailMessage[];
  /** thread id → page slug for every thread whose page is in the brain after the render loop. */
  slugByThread: ReadonlyMap<string, string>;
  /** Threads that have a rendered page which did NOT land this run (held, failed, carry-forward refused). */
  notLanded: ReadonlySet<string>;
  /** Threads with an unreadable message: never judged. */
  unavailableThreads: ReadonlySet<string>;
  /** The listing was complete (not truncated, readable) and no mail item failed this run. */
  listingClean: boolean;
}

async function detectOne(input: TrackInput, thread: GmailThreadData, slug: string, owners: Set<string>): Promise<void> {
  const verdict = await applyThreadLoopVerdict(input.engine, input.sourceId, thread, owners, slug, new Date(input.now()), NO_EXCLUSION);
  recordGraceVerdict(input.state.mail_loops!, thread, verdict, slug, owners, input.log, NO_EXCLUSION);
  if (verdict.withheld) input.run.withheld[verdict.withheld.reason] = (input.run.withheld[verdict.withheld.reason] ?? 0) + 1;
}

/** Eligibility candidate for the paid lane, recorded only when this source has consented to extraction. */
function noteCandidate(input: TrackInput, thread: GmailThreadData, slug: string, owners: Set<string>): void {
  const newestMs = thread.messages[thread.messages.length - 1]?.internalDateMs ?? 0;
  if (newestMs <= 0 || input.now() - newestMs > LOOPS_EXTRACT_WINDOW_DAYS * DAY_MS) return;
  const v = loopExtractionEligibility(thread, owners, NO_EXCLUSION);
  input.run.eligibility[v.reason] = (input.run.eligibility[v.reason] ?? 0) + 1;
  if (v.eligible && input.cfg.loopsExtractConsent) input.run.candidates.push({ slug, threadId: thread.threadId, newestMs });
}

/**
 * Detection over this run's listing, grace-hold settling and the freshness stamp. Never throws: a thread that
 * cannot be judged is a gap (the run is not complete), not a sync failure.
 */
export async function trackMailLoops(input: TrackInput): Promise<void> {
  const { cfg, state, log, run } = input;
  const loops = state.mail_loops ??= {};
  const owners = new Set(cfg.mailOwnerAddresses);
  const listed = new Map<string, AppleLoopMessage[]>();
  for (const t of groupMailThreads(input.messages)) {
    const compact = t.messages.map(compactMailMessage).filter((m): m is AppleLoopMessage => m !== null);
    if (compact.length > 0) listed.set(t.threadId, compact);
  }
  mergeLoopThreads(loops, listed, input.now());

  const processed = new Set<string>();
  let unclassified = 0;
  for (const threadId of [...listed.keys()].sort()) {
    if (input.signal?.aborted) { run.gaps.push('aborted'); return; }
    if (input.unavailableThreads.has(threadId)) { run.gaps.push('unavailable_thread'); continue; }
    if (input.notLanded.has(threadId)) { run.gaps.push('page_not_imported'); continue; }
    const slug = input.slugByThread.get(threadId);
    if (!slug) continue; // a noise-only thread renders no page and carries no loop
    const thread = toLoopThread(threadId, loops.threads?.[threadId] ?? [], cfg.account);
    if (!thread) { unclassified++; continue; }
    try {
      await detectOne(input, thread, slug, owners);
      noteCandidate(input, thread, slug, owners);
      processed.add(threadId);
    } catch (e) {
      run.gaps.push('detection_failed');
      log(`[apple] loop detection failed for a mail thread (${e instanceof Error ? e.message : String(e)}); it re-runs on the next touch`);
    }
  }
  if (unclassified > 0) {
    run.gaps.push('unclassified_messages');
    log(`[apple] ${unclassified} mail thread(s) have messages the reader did not classify (automated/bulk headers); open-loop tracking refuses them`);
  }

  // An unmute's re-check and time passing: holds due now open (or close) from the stored messages, no reader call.
  try {
    const holds = loops.loop_grace_holds ??= {};
    for (const r of await muteRecheckThreads(input.engine, input.sourceId)) {
      if (!holds[r.thread_id]) holds[r.thread_id] = { due_ms: input.now(), slug: r.page_slug, rev: null, spec: null };
    }
    const settled = await settleDueGraceHolds({
      engine: input.engine, sourceId: input.sourceId, state: loops, log: (m) => log(m.replace('[google]', '[apple]')), signal: input.signal,
      processed, now: input.now(), exclusion: NO_EXCLUSION,
      refetch: async (threadId) => {
        const stored = loops.threads?.[threadId];
        const slug = holds[threadId]?.slug ?? input.slugByThread.get(threadId) ?? null;
        if (!stored || !slug) return 'gone';
        const thread = toLoopThread(threadId, stored, cfg.account);
        if (!thread) return 'failed';
        await detectOne(input, thread, slug, owners);
        return 'ok';
      },
    });
    if (settled === 'aborted') run.gaps.push('aborted');
  } catch (e) {
    run.gaps.push('grace_settle_failed');
    log(`[apple] loop grace settle failed (retried next sweep): ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!input.listingClean) run.gaps.push('mail_listing_partial');
  if (run.gaps.length === 0) {
    loops.complete_at = new Date(input.now()).toISOString();
    delete loops.reread;
    loops.extract_seen = cfg.loopsExtractConsent;
    return;
  }
  // A gap the cursor cannot repair (detection or settle failure) re-reads the whole window next run.
  if (run.gaps.some((g) => g === 'detection_failed' || g === 'grace_settle_failed')) loops.reread = true;
  log(`[apple] mail loops not fresh this run (${[...new Set(run.gaps)].join(', ')}); the answer stays stale until a complete Mail sweep`);
}

// ── Extraction (paid) ────────────────────────────────────────────────────────

export interface AppleExtractionPolicy {
  /** Why paid extraction may not run for this source right now, or null. */
  refusal: string | null;
  /** The owner addresses (the model is told who "me" is). */
  owners: string[];
}

/** Used at enqueue and again in the job handler: the Apple consent and every Apple-side exclusion. */
export async function appleExtractionPolicy(engine: BrainEngine, sourceId: string, cfgIn?: AppleSourceConfig): Promise<AppleExtractionPolicy> {
  let cfg = cfgIn;
  if (!cfg) {
    const [row] = await engine.executeRaw<{ config: unknown; local_path: string | null }>('SELECT config, local_path FROM sources WHERE id = $1 AND archived IS NOT TRUE', [sourceId]);
    const raw = row ? parseSourceConfig(row.config) : null;
    if (!row || raw?.kind !== 'apple') return { refusal: 'apple_source_unavailable', owners: [] };
    cfg = parseAppleSourceConfig(raw, row.local_path ?? '');
  }
  const owners = cfg.mailOwnerAddresses;
  const a = appleLoopsAvailability(cfg);
  if (!a.available) return { refusal: a.reason, owners };
  if (!cfg.loopsExtractConsent) return { refusal: 'apple_consent_missing', owners };
  // Gmail label exclusions cannot be evaluated on Mail threads: fail closed for paid extraction.
  if ((await excludedLabelTokens(engine, {})).length > 0) return { refusal: 'excluded_label_unsupported', owners };
  return { refusal: null, owners };
}

/** Post-save enqueue of eligible threads. Both the global switch and the Apple consent must hold before anything else is called. */
export async function enqueueAppleLoopsExtraction(input: { engine: BrainEngine; sourceId: string; cfg: AppleSourceConfig; run: AppleLoopsRun; log: (m: string) => void }): Promise<LoopsEnqueueReport | undefined> {
  const { engine, sourceId, cfg, run, log } = input;
  if (!appleLoopsAvailability(cfg).available) return undefined;
  if (!cfg.loopsExtractConsent) {
    log('[apple] loops_extract: Apple extraction consent is off (a_loops_extract_consent) — no mail text is sent to a model');
    return { enqueued: 0, deferred: 0, skipped_reason: 'apple_consent_missing' };
  }
  if (!(await isLoopsExtractionEnabled(engine))) {
    log('[apple] loops_extract: extraction disabled (loops.extraction_enabled) — nothing enqueued');
    return { enqueued: 0, deferred: 0, skipped_reason: 'extraction_disabled' };
  }
  const { refusal } = await appleExtractionPolicy(engine, sourceId, cfg);
  if (refusal) {
    log(`[apple] loops_extract: withheld (${refusal})`);
    return { enqueued: 0, deferred: 0, skipped_reason: refusal };
  }
  return enqueueLoopsExtraction({ engine, sourceId, exclusion: NO_EXCLUSION, extractCandidates: run.candidates, log }, 'apple');
}
