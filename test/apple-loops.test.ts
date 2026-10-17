/**
 * apple-loops — open-loop parity for Apple Mail (#6855 finding 8), end to end on PGLite with injected fake
 * AppleReaders and a fake chat transport (no macOS, no helper, no provider call). Placeholders only.
 *
 * Every guard the feature adds is pinned by a test that FAILS when the guard is removed (see the "guard"
 * notes): identity (owner addresses only), consent (global switch AND Apple consent), freshness (only a
 * complete Mail loop sweep), fail-closed classification, and Google isolation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runAppleSync } from '../src/core/apple/apple-source.ts';
import { readAppleState } from '../src/core/apple/state.ts';
import { parseAppleSourceConfig, parseOwnerAddresses } from '../src/core/apple/source-config.ts';
import { appleLoopsAvailability, appleLoopsFreshness, appleOwnerDigest } from '../src/core/apple/loops-status.ts';
import { compactMailMessage, toLoopThread, appleExtractionPolicy } from '../src/core/apple/loops.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { addSuppression } from '../src/core/loops/loops-store.ts';
import { __clearSuppressionCacheForTests } from '../src/core/google/loop-detect.ts';
import { runLoopsExtract } from '../src/core/google/loops-extract.ts';
import { enqueueLoopsExtraction } from '../src/core/google/loops-enqueue.ts';
import { NO_EXCLUSION } from '../src/core/google/loops-exclusion.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import type { AppleMailListing, AppleMailMessage, AppleReaders } from '../src/core/apple/types.ts';

let engine: PGLiteEngine;
let schemaVersion: string;
let chatCalls = 0;
const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  // The fake model: counts calls and returns "nothing found". No provider is ever reached.
  __setChatTransportForTests(async (): Promise<ChatResult> => {
    chatCalls++;
    return { text: '{"commitments":[],"decisions_pending":[]}', blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
  });
}, 60_000);
afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  for (const sql of ['DELETE FROM minion_jobs', 'DELETE FROM op_checkpoints', 'DELETE FROM mcp_spend_reservations', 'DELETE FROM mcp_spend_log', "DELETE FROM config WHERE key LIKE 'loops.%'"]) {
    await engine.executeRaw(sql).catch(() => undefined);
  }
  chatCalls = 0;
  __clearSuppressionCacheForTests();
});

const SID = 'amail';
const OWNER = 'me-example@example.com';
const BASE = Date.now();
const hoursAgo = (h: number): string => new Date(BASE - h * 3_600_000).toISOString();
const clock = { t: BASE };

function msg(id: string, threadId: string, over: Partial<AppleMailMessage> & { hoursAgo: number }): AppleMailMessage {
  const { hoursAgo: h, ...rest } = over;
  return { id, threadId, mailbox: 'INBOX', subject: 'Quarterly plan', from: 'Alice Example <alice-example@example.com>', to: [OWNER], cc: [], date: hoursAgo(h), body: 'Can you review the plan?', read: true, automated: false, bulk: false, ...rest };
}
const inbound = (id: string, thread: string, h: number, over: Partial<AppleMailMessage> = {}) => msg(id, thread, { hoursAgo: h, ...over });
const outbound = (id: string, thread: string, h: number, over: Partial<AppleMailMessage> = {}) =>
  msg(id, thread, { hoursAgo: h, mailbox: 'Sent', from: OWNER, to: ['bob-example@example.com'], subject: 'Re: Quarterly plan', body: 'Could you send the numbers?', ...over });

interface Fake { mail: AppleMailMessage[]; flags?: Omit<AppleMailListing, 'messages'>; calls: { mail: number; contacts: number; calendar: number }; sinceFilter?: boolean; lastSince?: Date }
const fake = (mail: AppleMailMessage[] = []): Fake => ({ mail, calls: { mail: 0, contacts: 0, calendar: 0 } });
function readers(f: Fake): AppleReaders {
  return {
    async calendar() { f.calls.calendar++; return []; },
    async contacts() { f.calls.contacts++; return []; },
    async mail(opts) {
      f.calls.mail++; f.lastSince = opts.since;
      const all = f.sinceFilter ? f.mail.filter((m) => Date.parse(m.date) > opts.since.getTime()) : f.mail;
      return { messages: structuredClone(all), ...(f.flags ?? {}) };
    },
    async probe() { return { ok: true as const }; },
  };
}

const logs: string[] = [];
type RawCfg = Record<string, unknown>;
const baseCfg = (dir: string, extra: RawCfg = {}): RawCfg => ({ kind: 'apple', a_account: 'alice-example', a_dir: dir, a_services: 'contacts,mail', a_mail_owner_addresses: OWNER, ...extra });
const newDir = (): string => mkdtempSync(join(tmpdir(), 'aloops-'));
const withHome = <T,>(fn: () => Promise<T>): Promise<T> => withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, fn);

async function insertSource(dir: string, extra: RawCfg = {}): Promise<RawCfg> {
  const cfg = baseCfg(dir, extra);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb) ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`, [SID, dir, JSON.stringify(cfg)]);
  return cfg;
}
async function sweep(dir: string, f: Fake, raw: RawCfg, opts: Partial<SyncOpts> = {}) {
  const cfg = parseAppleSourceConfig(raw, dir);
  return runAppleSync(engine, SID, cfg, { sourceId: SID, noEmbed: true, noExtract: true, ...opts }, { readers: readers(f), now: () => clock.t, log: (m) => { logs.push(m); } });
}
async function loops(): Promise<Array<{ loop_type: string; status: string; counterparty_email: string | null; thread_id: string | null; closed_by: string | null; detector: string }>> {
  return engine.executeRaw(`SELECT loop_type, status, counterparty_email, thread_id, closed_by, detector FROM open_loops WHERE source_id = $1 ORDER BY thread_id, loop_type`, [SID]);
}
const open = async () => (await loops()).filter((l) => l.status === 'open');
const jobs = () => engine.executeRaw<{ idempotency_key: string; data: Record<string, unknown> }>(`SELECT idempotency_key, data FROM minion_jobs WHERE name = 'loops_extract' ORDER BY id`);
function ctx(): OperationContext {
  return { engine, config: {} as OperationContext['config'], logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: SID } as OperationContext;
}
const openLoopsOp = loopsOperations.find((o) => o.name === 'open_loops')!;
const waiting = async (): Promise<any> => openLoopsOp.handler(ctx(), { source_id: SID, group_by: 'counterparty', include_context: false });

beforeEach(() => { clock.t = Date.now(); logs.length = 0; });

// ── Deterministic detection ──────────────────────────────────────────────────

describe('apple loops — deterministic detection (no model, no consent needed)', () => {
  test('inbound owed after grace and outbound awaited open; fresh inbound and answered threads do not', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([
      inbound('m-in', 'thr-in', 48),                               // owed: 48h > 24h grace
      inbound('m-fresh', 'thr-fresh', 2),                          // inside the grace window
      outbound('m-out', 'thr-out', 100),                           // awaited: ask older than 72h
      outbound('m-out-fresh', 'thr-out-fresh', 10),                // inside the 72h outbound grace
    ]);
    await sweep(dir, f, raw);
    const rows = await open();
    expect(rows.map((r) => [r.thread_id, r.loop_type, r.counterparty_email])).toEqual([
      ['thr-in', 'unanswered_inbound', 'alice-example@example.com'],
      ['thr-out', 'unanswered_outbound', 'bob-example@example.com'],
    ]);
    expect(rows.every((r) => r.detector === 'deterministic_thread')).toBe(true);
    expect(chatCalls).toBe(0);
    expect(await jobs()).toHaveLength(0);
    // The two grace-held threads are remembered, not opened.
    expect(Object.keys(readAppleState(dir).mail_loops!.loop_grace_holds ?? {}).sort()).toEqual(['thr-fresh', 'thr-out-fresh']);
  }));

  test('a user reply closes the owed loop (turn flip), and their reply closes the awaited one', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('m-in', 'thr-in', 60), outbound('m-out', 'thr-out', 100)]);
    await sweep(dir, f, raw);
    expect(await open()).toHaveLength(2);

    f.mail.push(outbound('m-reply', 'thr-in', 40, { body: 'Here is my review.', to: ['alice-example@example.com'] }));
    f.mail.push(inbound('m-answer', 'thr-out', 10, { from: 'bob-example@example.com', body: 'Numbers attached.' }));
    await sweep(dir, f, raw);
    const all = await loops();
    expect(all.filter((l) => l.status === 'open')).toHaveLength(0);
    expect(all.map((l) => [l.thread_id, l.loop_type, l.status, l.closed_by])).toEqual([
      ['thr-in', 'unanswered_inbound', 'done', 'reply_detected'], ['thr-out', 'unanswered_outbound', 'done', 'reply_detected']]);
    // Their reply (10h old, inside the grace window) is held, not an instantly owed loop.
    expect(Object.keys(readAppleState(dir).mail_loops!.loop_grace_holds ?? {})).toEqual(['thr-out']);
  }));

  test('a grace-held loop opens from stored messages when time passes with no new mail (no reader data needed)', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('m-fresh', 'thr-fresh', 2)]);
    f.sinceFilter = true;
    await sweep(dir, f, raw);
    expect(await open()).toHaveLength(0);
    clock.t = BASE + 30 * 3_600_000; // 30h later: 32h old, past the 24h grace. The reader lists nothing newer.
    await sweep(dir, f, raw);
    expect((await open()).map((r) => r.thread_id)).toEqual(['thr-fresh']);
  }));

  test('direction comes from owner addresses only: an unlisted alias in Sent is NOT assumed to be the owner (guard: no Sent guessing)', () => withHome(async () => {
    const dir = newDir();
    const alias = 'me-alias@example.com';
    const thread = [outbound('m-1', 'thr-alias', 100, { from: alias })];
    const f = fake(thread);
    const raw = await insertSource(dir);
    await sweep(dir, f, raw);
    expect(await open()).toHaveLength(0); // in Sent, but not an owner address: nothing is judged mine
    const withAlias = baseCfg(dir, { a_mail_owner_addresses: `${OWNER},${alias}` });
    await insertSource(dir, { a_mail_owner_addresses: `${OWNER},${alias}` });
    await sweep(dir, f, withAlias);
    expect((await open()).map((r) => r.loop_type)).toEqual(['unanswered_outbound']);
  }));

  test('muted senders open no new loop; noise senders render no page and no loop; no Gmail labels are invented', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    await addSuppression(engine, SID, 'sender', 'alice-example@example.com');
    __clearSuppressionCacheForTests();
    const f = fake([inbound('m-muted', 'thr-muted', 60), inbound('m-noise', 'thr-noise', 60, { from: 'noreply@acme-example.com' }),
      inbound('m-list', 'thr-list', 60, { from: 'carol-example@example.com', bulk: true }), inbound('m-auto', 'thr-auto', 60, { from: 'dave-example@example.com', automated: true })]);
    await sweep(dir, f, raw);
    expect(await open()).toHaveLength(0);
    const thread = toLoopThread('t', [compactMailMessage(inbound('x', 't', 1))!], 'acct')!;
    expect(thread.messages.every((m) => m.labelIds.length === 0)).toBe(true);
  }));

  test('a message the reader did not classify refuses its thread and keeps the run non-fresh (guard: fail closed)', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const unclassified = inbound('m-u', 'thr-u', 60);
    delete unclassified.automated; delete unclassified.bulk;
    const f = fake([unclassified, inbound('m-ok', 'thr-ok', 60, { from: 'erin-example@example.com' })]);
    await sweep(dir, f, raw);
    expect((await open()).map((r) => r.thread_id)).toEqual(['thr-ok']);
    expect(readAppleState(dir).mail_loops!.complete_at).toBeUndefined();
    expect(logs.join('\n')).toContain('did not classify');
  }));

  test('a thread whose page did not land (import refused) opens no loop and the run is not fresh (guard: holds)', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('bad\u0000id', 'thr-bad', 60), inbound('m-ok', 'thr-ok', 60, { from: 'erin-example@example.com' })]);
    const r = await sweep(dir, f, raw);
    expect(r.failedFiles).toBe(1);
    expect((await open()).map((x) => x.thread_id)).toEqual(['thr-ok']);
    expect(readAppleState(dir).mail_loops!.complete_at).toBeUndefined();
  }));

  test('a HELD thread (import failed on 3 runs, now skipped without a new failure) opens no loop and the run stays non-fresh (guard: notLanded)', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('bad\u0000id', 'thr-bad', 60), inbound('m-ok', 'thr-ok', 60, { from: 'erin-example@example.com' })]);
    for (let i = 0; i < 3; i++) await sweep(dir, f, raw);
    const r4 = await sweep(dir, f, raw);
    expect(r4.failedFiles ?? 0).toBe(0);            // held: skipped, not a fresh failure
    expect(r4.connectorHolds).toMatchObject({ held: 1 });
    expect((await open()).map((x) => x.thread_id)).toEqual(['thr-ok']);
    expect(readAppleState(dir).mail_loops!.complete_at).toBeUndefined(); // a skipped thread is a coverage gap
  }));

  test('a thread the reader flags unavailable is never judged', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('m-1', 'thr-gone', 60), inbound('m-2', 'thr-ok', 60, { from: 'erin-example@example.com' })]);
    f.flags = { unavailableThreads: ['thr-gone'] };
    await sweep(dir, f, raw);
    expect((await open()).map((r) => r.thread_id)).toEqual(['thr-ok']);
    expect(readAppleState(dir).mail_loops!.complete_at).toBeUndefined();
  }));
});

// ── Availability: identity, service opt-out ──────────────────────────────────

describe('apple loops — availability', () => {
  test('missing owner addresses: sync imports mail, tracking is unavailable (identity_missing), never "clean"', () => withHome(async () => {
    const dir = newDir();
    const raw = baseCfg(dir); delete raw.a_mail_owner_addresses;
    await insertSource(dir); await engine.executeRaw('UPDATE sources SET config = $2::text::jsonb WHERE id = $1', [SID, JSON.stringify(raw)]);
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    const r = await sweep(dir, f, raw);
    expect(r.added).toBe(1); // the page was imported
    expect(await loops()).toHaveLength(0);
    expect(readAppleState(dir).mail_loops).toBeUndefined();
    expect(r.loops_enqueue).toBeUndefined();
    const res = await waiting();
    expect(res.apple_loops_unavailable).toEqual([{ source_id: SID, reason: 'identity_missing' }]);
    expect(res.no_google_sources).toBe(false);
    expect(res.text).toContain('identity_missing');
    expect(res.text).not.toContain('You are clean');
    expect(res.text).not.toContain('No google source is connected');
  }));

  test('mail not enabled: the mail reader is never called, no loop state is written, and the op ignores the source', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir, { a_services: 'contacts' });
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    const r = await sweep(dir, f, raw);
    expect(f.calls.mail).toBe(0);
    expect(await loops()).toHaveLength(0);
    expect(readAppleState(dir).mail_loops).toBeUndefined();
    expect(r.loops_enqueue).toBeUndefined();
    const res = await waiting();
    expect(res.apple_loops_unavailable).toBeUndefined();
    expect(res.sources).toEqual([]);
    expect(res.no_google_sources).toBe(true);
  }));

  test('availability helper: mail + owners required; consent is separate', () => {
    const base = { services: ['mail' as const], mailOwnerAddresses: [OWNER], loopsExtractConsent: false };
    expect(appleLoopsAvailability(base)).toEqual({ available: true, extraction: 'consent_missing' });
    expect(appleLoopsAvailability({ ...base, loopsExtractConsent: true })).toEqual({ available: true, extraction: 'enabled' });
    expect(appleLoopsAvailability({ ...base, mailOwnerAddresses: [] })).toEqual({ available: false, reason: 'identity_missing' });
    expect(appleLoopsAvailability({ ...base, services: [] })).toEqual({ available: false, reason: 'mail_disabled' });
    expect(parseOwnerAddresses('ME@Example.com, bad, a@b, me@example.com,<x@y.z>')).toEqual(['me@example.com']);
  });
});

// ── Freshness ────────────────────────────────────────────────────────────────

describe('apple loops — freshness (open_loops / waiting)', () => {
  test('a contacts sync never freshens Mail loops; partial Mail stays stale; a complete Mail sweep freshens (guard: complete_at only)', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    f.flags = { truncated: true };
    await sweep(dir, f, raw);
    const [src] = await engine.executeRaw<{ last_sync_at: string | null }>('SELECT last_sync_at FROM sources WHERE id=$1', [SID]);
    expect(src!.last_sync_at).not.toBeNull(); // contacts synced cleanly and stamped the source
    let res = await waiting();
    expect(res.stale).toBe(true); // ...but Mail loops are not fresh
    expect(res.sources[0].last_sync_at).toBeNull();
    expect(res.groups).toHaveLength(1); // the loop that WAS detected is still shown, with the stale warning
    expect(res.text).toContain('have not synced recently');

    f.flags = undefined;
    await sweep(dir, f, raw);
    res = await waiting();
    expect(res.stale).toBe(false);
    expect(Date.parse(res.sources[0].last_sync_at)).toBeGreaterThan(BASE - 1000);
  }));

  test('freshness is bound to the owner set: changing owners makes stored freshness stale until re-detection', () => {
    const state = { mail_loops: { digest: appleOwnerDigest([OWNER]), complete_at: new Date(BASE).toISOString() } };
    expect(appleLoopsFreshness({ mailOwnerAddresses: [OWNER] }, state, BASE).stale).toBe(false);
    expect(appleLoopsFreshness({ mailOwnerAddresses: [OWNER, 'other@example.com'] }, state, BASE).stale).toBe(true);
    expect(appleLoopsFreshness({ mailOwnerAddresses: [OWNER] }, { mail_loops: { ...state.mail_loops, reread: true } }, BASE).stale).toBe(true);
    expect(appleLoopsFreshness({ mailOwnerAddresses: [OWNER] }, state, BASE + 25 * 3_600_000).stale).toBe(true);
    expect(appleLoopsFreshness({ mailOwnerAddresses: [OWNER] }, null, BASE).stale).toBe(true);
  });

  test('changing owner addresses re-reads the whole window once even when the incremental cursor sees nothing new', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir);
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    f.sinceFilter = true;
    await sweep(dir, f, raw);
    const windowStart = f.lastSince!.getTime();
    await sweep(dir, f, raw);
    expect(f.lastSince!.getTime()).toBeGreaterThan(windowStart); // incremental: starts after the newest message
    const widened = baseCfg(dir, { a_mail_owner_addresses: `${OWNER},me-alias@example.com` });
    await sweep(dir, f, widened);
    expect(f.lastSince!.getTime()).toBe(windowStart); // full window again
    expect(readAppleState(dir).mail_loops!.digest).toBe(appleOwnerDigest([OWNER, 'me-alias@example.com']));
  }));
});

// ── Extraction: consent matrix, enqueue, dedupe ──────────────────────────────

describe('apple loops — extraction requires BOTH the global switch and Apple consent', () => {
  const cases: Array<[string, boolean, boolean, boolean]> = [
    ['global on, Apple consent off', true, false, false],
    ['global off, Apple consent on', false, true, false],
    ['global off, Apple consent off', false, false, false],
    ['global on, Apple consent on', true, true, true],
  ];
  for (const [name, global, consent, enqueues] of cases) {
    test(`${name}: ${enqueues ? 'enqueues' : 'enqueues nothing'}; deterministic loops open either way; no model call during sync`, () => withHome(async () => {
      const dir = newDir();
      const raw = await insertSource(dir, consent ? { a_loops_extract_consent: true } : {});
      await engine.setConfig('loops.extraction_enabled', global ? 'true' : 'false');
      const f = fake([inbound('m-in', 'thr-in', 60)]);
      const r = await sweep(dir, f, raw);
      expect((await open()).map((x) => x.loop_type)).toEqual(['unanswered_inbound']);
      expect((await jobs()).length).toBe(enqueues ? 1 : 0);
      expect(chatCalls).toBe(0);
      if (!enqueues) expect(r.loops_enqueue).toMatchObject({ enqueued: 0, skipped_reason: consent ? 'extraction_disabled' : 'apple_consent_missing' });
    }));
  }

  test('with consent on: the job is revision-keyed (rerun dedupes, a new message enqueues a new revision) and carries the Apple page', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir, { a_loops_extract_consent: true });
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    await sweep(dir, f, raw);
    await sweep(dir, f, raw);
    const first = await jobs();
    expect(first).toHaveLength(1);
    expect(first[0]!.idempotency_key).toMatch(new RegExp(`^loops:${SID}:emails/.+:\\d+$`));
    expect(first[0]!.data).toMatchObject({ sourceId: SID, threadId: 'thr-in' });
    expect(typeof first[0]!.data.newestMs).toBe('number');
    f.mail.push(inbound('m-in-2', 'thr-in', 50, { body: 'Following up on the plan?' }));
    await sweep(dir, f, raw);
    const after = await jobs();
    expect(after).toHaveLength(2);
    expect(new Set(after.map((j) => j.idempotency_key)).size).toBe(2);
  }));

  test('turning consent on later re-candidates the window once even though no mail changed (guard: reread on consent)', () => withHome(async () => {
    const dir = newDir();
    const off = await insertSource(dir);
    // A newer noise message pins the incremental cursor past thr-in, so only a deliberate re-read can see it again.
    const f = fake([inbound('m-in', 'thr-in', 60), inbound('m-new', 'thr-new', 1, { from: 'noreply@acme-example.com' })]);
    f.sinceFilter = true;
    await sweep(dir, f, off);
    await sweep(dir, f, off);
    expect(await jobs()).toHaveLength(0);
    const on = await insertSource(dir, { a_loops_extract_consent: true });
    await sweep(dir, f, on);
    expect((await jobs()).map((j) => j.data.threadId)).toEqual(['thr-in']);
  }));

  test('threads that are noise, list or owner-less bulk mail are not eligible; the count is recorded without text', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir, { a_loops_extract_consent: true });
    const f = fake([inbound('m-list', 'thr-list', 60, { from: 'carol-example@example.com', bulk: true }), inbound('m-ok', 'thr-ok', 60, { from: 'erin-example@example.com' })]);
    await sweep(dir, f, raw);
    expect((await jobs()).map((j) => j.data.threadId)).toEqual(['thr-ok']);
    const line = logs.find((l) => l.includes('loops_extract eligibility'))!;
    expect(line).toContain('list_mail=1');
    expect(line).not.toContain('example.com');
  }));

  test('Gmail label exclusions cannot be evaluated on Mail: configured, paid extraction is withheld (fail closed); deterministic tracking unaffected', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir, { a_loops_extract_consent: true });
    await engine.setConfig('loops.extraction_exclude_labels', 'Newsletters');
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    const r = await sweep(dir, f, raw);
    expect(await jobs()).toHaveLength(0);
    expect(r.loops_enqueue).toMatchObject({ enqueued: 0, skipped_reason: 'excluded_label_unsupported' });
    expect(await open()).toHaveLength(1);
  }));

  test('the job handler re-checks the Apple consent at run time (consent revoked after enqueue → no model call)', () => withHome(async () => {
    const dir = newDir();
    const raw = await insertSource(dir, { a_loops_extract_consent: true });
    const f = fake([inbound('m-in', 'thr-in', 60)]);
    await sweep(dir, f, raw);
    const [job] = await jobs();
    const payload = { slug: String(job!.data.slug), sourceId: SID, threadId: 'thr-in' };

    await insertSource(dir); // consent revoked
    expect(await runLoopsExtract(engine, payload)).toMatchObject({ status: 'skipped', reason: 'apple_consent_missing' });
    expect(chatCalls).toBe(0);

    await insertSource(dir, { a_loops_extract_consent: true });
    expect(await runLoopsExtract(engine, payload)).toMatchObject({ status: 'extracted' });
    expect(chatCalls).toBe(1);

    const cfg = parseAppleSourceConfig(baseCfg(dir), dir);
    expect((await appleExtractionPolicy(engine, SID, cfg)).refusal).toBe('apple_consent_missing');
    expect((await appleExtractionPolicy(engine, SID, { ...cfg, mailOwnerAddresses: [], loopsExtractConsent: true })).refusal).toBe('identity_missing');
  }));
});

// ── Google isolation ─────────────────────────────────────────────────────────

describe('google behavior is unchanged', () => {
  test('the shared enqueue keeps its [google] log prefix by default and takes the label only from the Apple caller', async () => {
    const lines: string[] = [];
    const deps = { engine, sourceId: 'g1', exclusion: NO_EXCLUSION, extractCandidates: [], log: (m: string) => lines.push(m) };
    await enqueueLoopsExtraction(deps);
    await enqueueLoopsExtraction(deps, 'apple');
    expect(lines).toEqual(['[google] loops_extract: no eligible thread in this sweep; nothing to enqueue', '[apple] loops_extract: no eligible thread in this sweep; nothing to enqueue']);
  });

  test('a Google page is not subject to the Apple consent check in the job handler', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter) VALUES ('emails/g-1', 'g1', 'email', 'x', 'Thread body', '{"thread_id":"t1"}'::jsonb)`);
    expect(await runLoopsExtract(engine, { slug: 'emails/g-1', sourceId: 'g1', threadId: 't1' })).toMatchObject({ status: 'extracted' });
    expect(chatCalls).toBe(1);
  });

  test('open_loops on a brain with only a google source answers as before (no apple keys)', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config, last_sync_at) VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb, now()) ON CONFLICT (id) DO NOTHING`);
    const res: any = await openLoopsOp.handler({ ...ctx(), sourceId: 'g1' }, { source_id: 'g1', group_by: 'counterparty', include_context: false });
    expect(res.apple_loops_unavailable).toBeUndefined();
    expect(res.stale).toBe(false);
    expect(res.text).toContain('You are clean');
    expect(res.text).not.toContain('Apple');
  });
});

// ── CLI / config surface ─────────────────────────────────────────────────────

import { buildAppleAddOptions, AppleAddFlagError } from '../src/commands/sources-apple-flags.ts';
import { runApple } from '../src/commands/apple.ts';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';
import { appleTuningConfig } from '../src/core/apple/source-config.ts';
import { connectorIdentity, CONNECTOR_LEAF_RULES } from '../src/core/persistence/connector-identity.ts';
import { randomUUID } from 'node:crypto';

describe('apple loops — flags, setup disclosure, identity', () => {
  const add = (over: Record<string, unknown>) => buildAppleAddOptions({ services: 'calendar,contacts,mail', confirmMail: true, dir: '/d', ...over } as never);

  test('owner addresses normalize; consent needs mail AND identity; invalid values never widen scope', () => {
    expect(add({ mailOwnerAddresses: 'Me@Example.com, me-alias@example.com' }).mailOwnerAddresses).toEqual(['me-alias@example.com', 'me@example.com']);
    expect(add({ mailOwnerAddresses: OWNER, loopsExtractConsent: true }).loopsExtractConsent).toBe(true);
    expect(add({}).loopsExtractConsent).toBeUndefined();
    const code = (fn: () => unknown): string => { try { fn(); return 'none'; } catch (e) { return (e as AppleAddFlagError).code; } };
    expect(code(() => add({ loopsExtractConsent: true }))).toBe('extraction_consent_requires_identity');
    expect(code(() => add({ services: 'calendar', mailOwnerAddresses: OWNER, loopsExtractConsent: true }))).toBe('invalid_value');
    expect(code(() => add({ mailOwnerAddresses: 'not-an-address' }))).toBe('invalid_value');
    expect(code(() => add({ mailOwnerAddresses: `${OWNER},bad` }))).toBe('invalid_value'); // a partial list is refused, not trimmed
  });

  test('config round-trip: only non-default keys are written; consent defaults false', () => {
    expect(appleTuningConfig(parseAppleSourceConfig({ kind: 'apple' }, '/d'))).toEqual({});
    const cfg = parseAppleSourceConfig({ kind: 'apple', a_mail_owner_addresses: [OWNER], a_loops_extract_consent: 'true' }, '/d');
    expect(cfg).toMatchObject({ mailOwnerAddresses: [OWNER], loopsExtractConsent: true });
    expect(appleTuningConfig(cfg)).toMatchObject({ a_mail_owner_addresses: OWNER, a_loops_extract_consent: true });
    expect(parseAppleSourceConfig({ kind: 'apple', a_loops_extract_consent: 'maybe' }, '/d').loopsExtractConsent).toBe(false);
  });

  test('connected parser accepts the flags only for --kind apple', () => {
    const parse = (...a: string[]) => parseSourceLifecycleArgs(['add', 'apple-x', ...a], randomUUID());
    const opts = (parse('--kind', 'apple', '--services', 'mail', '--confirm-mail', '--mail-owner-addresses', OWNER, '--consent-loops-extraction').params as { options: { apple: Record<string, unknown> } }).options.apple;
    expect(opts).toMatchObject({ mailOwnerAddresses: [OWNER], loopsExtractConsent: true });
    expect(() => parse('--kind', 'apple', '--services', 'mail', '--confirm-mail', '--consent-loops-extraction')).toThrow(/needs --mail-owner-addresses/);
    expect(() => parseSourceLifecycleArgs(['add', 'g', '--kind', 'google', '--account', 'a@example.com', '--mail-owner-addresses', OWNER], randomUUID())).toThrow(/requires --kind apple/);
    expect(() => parseSourceLifecycleArgs(['add', 'g', '--kind', 'google', '--account', 'a@example.com', '--consent-loops-extraction'], randomUUID())).toThrow(/requires --kind apple/);
  });

  test('identity: owner addresses and consent are excluded leaves (changing them never re-keys the checkpoint)', () => {
    expect(CONNECTOR_LEAF_RULES.apple.mailOwnerAddresses).toBe('excluded');
    expect(CONNECTOR_LEAF_RULES.apple.loopsExtractConsent).toBe('excluded');
    const id = (raw: RawCfg) => connectorIdentity('apple', { kind: 'apple', a_account: 'x', ...raw }, '/d').digest;
    expect(id({})).toBe(id({ a_mail_owner_addresses: OWNER, a_loops_extract_consent: true }));
    expect(id({})).not.toBe(id({ a_mail_days: 5 }));
  });

  test('setup discloses that extraction sends Mail text to the chat provider, before any probe', async () => {
    let out = '';
    const probed: string[] = [];
    const rd: AppleReaders = { ...readers(fake()), async probe(s) { probed.push(s); return { ok: true as const }; } };
    const code = await runApple(['setup', '--json'], { platform: 'darwin', engine, readers: rd, write: (t) => { out += t; } });
    expect(code).toBe(2);
    expect(JSON.parse(out).next_action.user_message).toContain('chat provider');
    expect(probed).toEqual([]);
  });

  test('`apple loops` sets owners/consent on an existing source without reading Apple data, and revokes', async () => {
    const dir = newDir();
    await insertSource(dir); await engine.executeRaw('UPDATE sources SET config = $2::text::jsonb WHERE id = $1', [SID, JSON.stringify({ kind: 'apple', a_account: 'alice-example', a_dir: dir, a_services: 'contacts,mail' })]);
    const run = async (...args: string[]) => { let out = ''; const rd = readers(fake()); const code = await runApple(['loops', '--json', '--source', SID, ...args], { platform: 'darwin', engine, readers: rd, write: (t) => { out += t; } }); return { code, json: JSON.parse(out) }; };
    const cfgNow = async () => { const [r] = await engine.executeRaw<{ config: RawCfg }>('SELECT config FROM sources WHERE id=$1', [SID]); return r!.config; };

    const none = await run();
    expect(none.json.loops).toMatchObject({ available: false, unavailable: 'identity_missing' });
    expect(none.code).toBe(0);                                  // read-only status is not an error
    const refused = await run('--consent-loops-extraction');
    expect(refused.json.error.code).toBe('extraction_consent_requires_identity');
    expect((await cfgNow()).a_loops_extract_consent).toBeUndefined();

    const set = await run('--mail-owner-addresses', OWNER);
    expect(set.json.loops).toMatchObject({ available: true, extraction: 'consent_missing', owner_addresses: 1 });
    const consent = await run('--consent-loops-extraction');
    expect(consent.json.loops.extraction).toBe('consented');
    expect((await cfgNow()).a_loops_extract_consent).toBe(true);
    const revoked = await run('--revoke-loops-extraction');
    expect(revoked.json.loops.extraction).toBe('consent_missing');
    expect((await cfgNow()).a_loops_extract_consent).toBe(false);
  });
});

// ── Reader: the real mail.js classifies headers (stub Mail environment; Mail.app is never launched) ──

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MAIL_SCRIPT, normalizeMessage } from '../src/core/apple/readers/mail.ts';

describe('apple loops — mail.js header classification', () => {
  const headerSets: Array<[string, string, { automated: boolean; bulk: boolean }]> = [
    ['plain human mail', 'Message-ID: <a1>\nSubject: hi', { automated: false, bulk: false }],
    ['Auto-Submitted: auto-replied', 'Message-ID: <a2>\nAuto-Submitted: auto-replied', { automated: true, bulk: false }],
    ['Auto-Submitted: no is human', 'Message-ID: <a3>\nAuto-Submitted: no', { automated: false, bulk: false }],
    ['text/calendar part', 'Message-ID: <a4>\nContent-Type: text/calendar; method=REQUEST', { automated: true, bulk: false }],
    ['List-Unsubscribe', 'Message-ID: <a5>\nList-Unsubscribe: <mailto:u@example.com>', { automated: false, bulk: true }],
    ['List-Id', 'Message-ID: <a6>\nList-Id: <list.example.com>', { automated: false, bulk: true }],
    ['Precedence: bulk', 'Message-ID: <a7>\nPrecedence: bulk', { automated: false, bulk: true }],
    ['no-reply Reply-To', 'Message-ID: <a8>\nReply-To: noreply@example.com', { automated: false, bulk: true }],
    ['folded List-Id', 'Message-ID: <a9>\nList-\n Id: x', { automated: false, bulk: false }],
  ];
  test('each header set yields the documented verdict and the normalizer keeps only booleans', () => {
    const js = readFileSync(MAIL_SCRIPT, 'utf8');
    const dates = headerSets.map(() => new Date('2026-10-10T08:00:00.000Z'));
    const mailbox: any = { name: () => 'INBOX', id: () => 'inbox-example' };
    mailbox.messages = { whose: (query: any) => {
      let idx = dates.map((_, i) => i);
      if (Array.isArray(query?._or)) { const sel = new Set(query._or.map((x: any) => x.id._equals)); idx = idx.filter((i) => sel.has(i)); }
      return { id: () => idx, messageId: () => idx.map((i) => `<a${i + 1}>`), subject: () => idx.map(() => 's'), sender: () => idx.map(() => 'Alice Example <alice-example@example.com>'),
        dateReceived: () => idx.map((i) => dates[i]), readStatus: () => idx.map(() => true), allHeaders: () => idx.map((i) => headerSets[i]![1]), content: () => idx.map(() => 'body') };
    } };
    let output = '';
    const $: any = (v: string) => ({ dataUsingEncoding: () => v });
    $.NSUTF8StringEncoding = 1;
    $.NSFileHandle = { fileHandleWithStandardOutput: { writeData: (s: string) => { output = s; } } };
    $.exit = () => {};
    const sandbox = { ObjC: { import() {} }, $, Application: () => ({ running: () => true, accounts: () => [{}], inbox: mailbox, sentMailbox: mailbox }), console };
    try { runInNewContext(`${js}\nrun(${JSON.stringify(['--since', '2026-10-01T00:00:00.000Z', '--mailboxes', 'INBOX'])});`, sandbox); } catch (e) { if (!(e as { code?: number }).code) throw e; }
    const items = JSON.parse(output).items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(headerSets.length);
    for (const item of items) {
      const [name, , want] = headerSets[Number(String(item.id).replace(/\D/g, '')) - 1]!;
      expect([name, item.automated, item.bulk]).toEqual([name, want.automated, want.bulk]);
    }
    expect(normalizeMessage({ id: 'x', date: '2026-10-10T08:00:00Z', automated: 'yes', bulk: true })).toMatchObject({ bulk: true });
    expect('automated' in normalizeMessage({ id: 'x', date: '2026-10-10T08:00:00Z', automated: 'yes' })).toBe(false);
  });
});
