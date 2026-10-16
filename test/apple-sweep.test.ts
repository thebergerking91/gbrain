/**
 * apple-sweep — end-to-end sweeps of the apple source kind on a real PGLite
 * engine with an injected fake AppleReaders (no macOS, no helpers, runs on
 * Linux). Placeholders only: alice-example, acme-example, example.com.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
const read = readFileSync;
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { runAppleSync } from '../src/core/apple/apple-source.ts';
import { appleStateFile, readAppleState } from '../src/core/apple/state.ts';
import { parseAppleSourceConfig } from '../src/core/apple/source-config.ts';
import { AppleReaderError } from '../src/core/apple/types.ts';
import type {
  AppleCalendarEvent,
  AppleContact,
  AppleMailMessage,
  AppleReaders,
  AppleService,
} from '../src/core/apple/types.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

const SID = 'asrc';
const NOW = Date.parse('2026-10-16T12:00:00-07:00');
const fx = <T,>(name: string): T[] =>
  (JSON.parse(read(join(import.meta.dir, 'fixtures', 'apple', `${name}.json`), 'utf-8')) as { items: T[] }).items;

// ── Fake readers ─────────────────────────────────────────────────────────────

interface FakeApple {
  events: AppleCalendarEvent[];
  contacts: AppleContact[];
  mail: AppleMailMessage[];
  /** A service whose reader throws this. */
  fail: Partial<Record<AppleService, Error>>;
  calls: Record<AppleService, number>;
  lastCalendar?: { from: Date; to: Date; calendarIds: string[] };
  lastMail?: { since: Date; mailboxes: string[] };
}

function freshFake(): FakeApple {
  return {
    events: structuredClone(fx<AppleCalendarEvent>('calendar')),
    contacts: structuredClone(fx<AppleContact>('contacts')),
    mail: structuredClone(fx<AppleMailMessage>('mail')),
    fail: {}, calls: { calendar: 0, contacts: 0, mail: 0 },
  };
}

function readersOf(f: FakeApple): AppleReaders {
  return {
    async calendar(opts) {
      f.calls.calendar++;
      if (f.fail.calendar) throw f.fail.calendar;
      f.lastCalendar = { from: opts.from, to: opts.to, calendarIds: opts.calendarIds };
      return structuredClone(f.events);
    },
    async contacts() {
      f.calls.contacts++;
      if (f.fail.contacts) throw f.fail.contacts;
      return structuredClone(f.contacts);
    },
    async mail(opts) {
      f.calls.mail++;
      if (f.fail.mail) throw f.fail.mail;
      f.lastMail = { since: opts.since, mailboxes: opts.mailboxes };
      return structuredClone(f.mail);
    },
    async probe() { return { ok: true as const }; },
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────

async function insertSource(dir: string, extra: Record<string, unknown> = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)`,
    [SID, 'apple', dir, JSON.stringify({ kind: 'apple', a_account: 'alice-example', a_dir: dir, ...extra })],
  );
}

const logs: string[] = [];

async function sweep(dir: string, f: FakeApple, opts: Partial<SyncOpts> = {}, cfgRaw: Record<string, unknown> = {}) {
  const cfg = parseAppleSourceConfig({ kind: 'apple', a_account: 'alice-example', a_dir: dir, ...cfgRaw }, dir);
  return runAppleSync(engine, SID, cfg, { sourceId: SID, noEmbed: true, noExtract: true, ...opts },
    { readers: readersOf(f), now: () => NOW, log: (m) => { logs.push(m); } });
}

async function slugs(prefix: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE $2 ORDER BY slug`, [SID, `${prefix}%`]);
  return rows.map((r) => r.slug);
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, fn);
}

const newDir = (tag: string): string => mkdtempSync(join(tmpdir(), `asrc-${tag}-`));
const modeOf = (p: string): number => statSync(p).mode & 0o777;

function* walkFiles(dir: string, rel = ''): Generator<string> {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walkFiles(dir, r);
    else yield r;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('apple sweep — first sync, idempotence, rendering', () => {
  test('first sync lands calendar, contacts and mail pages; a rerun adds/modifies nothing', () => withHome(async () => {
    const dir = newDir('first');
    await insertSource(dir);
    const f = freshFake();

    const r1 = await sweep(dir, f);
    expect(r1.status).toBe('first_sync');
    // calendar: 3 (1 cancelled skipped) · contacts: 4 (1 renders nothing) · mail: 2 (1 automated skipped)
    expect(await slugs('calendar/')).toHaveLength(3);
    expect(await slugs('people/')).toHaveLength(4);
    expect(await slugs('emails/')).toHaveLength(2);
    expect(r1.added).toBe(9);
    expect(r1.modified).toBe(0);
    expect(r1.deleted).toBe(0);

    const r2 = await sweep(dir, f);
    expect(r2.status).toBe('up_to_date');
    expect(r2.added).toBe(0);
    expect(r2.modified).toBe(0);
    expect(r2.deleted).toBe(0);
    expect(r2.pagesAffected).toEqual([]);
  }));

  test('idempotent even when the state file is gone (page lookup + content hash agree)', () => withHome(async () => {
    const dir = newDir('nostate');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f);
    const { rmSync } = await import('node:fs');
    rmSync(appleStateFile(dir));
    const r = await sweep(dir, f);
    expect(r.added).toBe(0);
    expect(r.deleted).toBe(0);
  }));

  test('a changed item modifies exactly its own page', () => withHome(async () => {
    const dir = newDir('modify');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f);
    f.contacts[0].jobTitle = 'Staff Engineer';
    const r = await sweep(dir, f);
    expect(r.modified).toBe(1);
    expect(r.added).toBe(0);
    expect(r.pagesAffected).toEqual(['people/alice-example']);
  }));

  test('windows handed to the readers follow the config', () => withHome(async () => {
    const dir = newDir('windows');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f, {}, { a_history_days: 10, a_future_days: 5, a_calendar_ids: 'cal-work', a_mail_days: 7, a_mail_mailboxes: 'INBOX' });
    expect(f.lastCalendar!.from.getTime()).toBe(NOW - 10 * 86_400_000);
    expect(f.lastCalendar!.to.getTime()).toBe(NOW + 5 * 86_400_000);
    expect(f.lastCalendar!.calendarIds).toEqual(['cal-work']);
    expect(f.lastMail!.since.getTime()).toBe(NOW - 7 * 86_400_000);
    expect(f.lastMail!.mailboxes).toEqual(['INBOX']);
  }));

  test('a long thread keeps messages the mail window no longer lists', () => withHome(async () => {
    const dir = newDir('carry');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f);
    const before = await engine.executeRaw<{ compiled_truth: string }>(
      `SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug LIKE 'emails/%' AND frontmatter->>'apple_thread_id'='thr-001'`, [SID]);
    expect(before[0].compiled_truth).toContain('Please review the plan');
    // m-001 ages out of the window; a new reply arrives.
    f.mail = f.mail.filter((m) => m.id !== 'm-001');
    f.mail.push({ ...f.mail[0], id: 'm-006', threadId: 'thr-001', mailbox: 'INBOX', from: 'alice-example@example.com',
      date: '2026-10-16T08:00:00-07:00', body: 'Great, thanks.' });
    const r = await sweep(dir, f);
    expect(r.modified).toBe(1);
    const after = await engine.executeRaw<{ compiled_truth: string; frontmatter: Record<string, unknown> }>(
      `SELECT compiled_truth, frontmatter FROM pages WHERE source_id=$1 AND slug LIKE 'emails/%' AND frontmatter->>'apple_thread_id'='thr-001'`, [SID]);
    expect(after[0].compiled_truth).toContain('Please review the plan');
    expect(after[0].compiled_truth).toContain('Great, thanks.');
    expect(after[0].frontmatter.apple_message_ids).toEqual(['m-001', 'm-002', 'm-006']);
    // and it settles: the next identical sweep changes nothing.
    const again = await sweep(dir, f);
    expect(again.added + again.modified + again.deleted).toBe(0);
  }));
});

describe('apple sweep — hostile mail body', () => {
  test('the stored page keeps the connector frontmatter, no injected structure', () => withHome(async () => {
    const dir = newDir('hostile');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f);
    const rows = await engine.executeRaw<{ slug: string; type: string; title: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown> }>(
      `SELECT slug, type, title, compiled_truth, timeline, frontmatter FROM pages
        WHERE source_id=$1 AND frontmatter->>'apple_thread_id'='thr-002'`, [SID]);
    expect(rows).toHaveLength(1);
    const page = rows[0];
    expect(page.type).toBe('email');
    expect(page.title).toBe('Hostile body');
    expect(page.frontmatter.apple_thread_id).toBe('thr-002');
    expect(page.timeline.trim()).toBe('');
    // The injected text is still there — as quoted data inside a fence, not as page structure.
    expect(page.compiled_truth).toContain('# Injected heading');
    const lines = page.compiled_truth.split('\n');
    let fence: string | null = null;
    const outside: string[] = [];
    for (const l of lines) {
      if (fence !== null) { if (l === fence) fence = null; continue; }
      const m = /^(`{3,})$/.exec(l);
      if (m) { fence = m[1]; continue; }
      outside.push(l);
    }
    expect(outside.join('\n')).not.toContain('Injected');
    expect(outside.join('\n')).not.toContain('close attempt');
    expect(outside.join('\n')).not.toContain('<script>');
    expect(outside.filter((l) => /^#{1,6} /.test(l))).toHaveLength(2);
    // No page was created from the injected `type: person` frontmatter.
    expect((await engine.executeRaw(`SELECT 1 FROM pages WHERE source_id=$1 AND title='Injected'`, [SID]))).toHaveLength(0);
  }));
});

describe('apple sweep — service opt-out', () => {
  test('a disabled service is not read, written, hashed or deleted', () => withHome(async () => {
    const dir = newDir('optout');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f);
    const mailBefore = await slugs('emails/');
    const stateBefore = readAppleState(dir);
    expect(Object.keys(stateBefore.mail.hashes).length).toBe(2);

    // Opt out of mail, and make upstream mail disappear entirely: nothing may be touched.
    const calls = { ...f.calls };
    f.mail = [];
    f.contacts[0].jobTitle = 'Principal Engineer';
    const r = await sweep(dir, f, { full: true }, { a_services: 'calendar,contacts' });
    expect(f.calls.mail).toBe(calls.mail);
    expect(await slugs('emails/')).toEqual(mailBefore);
    expect(r.deleted).toBe(0);
    expect(r.modified).toBe(1);
    // Its hashes survive for the day it is re-enabled.
    expect(readAppleState(dir).mail.hashes).toEqual(stateBefore.mail.hashes);
  }));

  test.each([
    ['calendar', 'calendar/', 3],
    ['contacts', 'people/', 4],
    ['mail', 'emails/', 2],
  ] as const)('only %s enabled reads only that reader', (service, prefix, count) => withHome(async () => {
    const dir = newDir(`only-${service}`);
    await insertSource(dir);
    const f = freshFake();
    const r = await sweep(dir, f, {}, { a_services: service });
    for (const s of ['calendar', 'contacts', 'mail'] as const) expect(f.calls[s]).toBe(s === service ? 1 : 0);
    expect(r.added).toBe(count);
    expect(await slugs(prefix)).toHaveLength(count);
    for (const other of ['calendar/', 'people/', 'emails/'].filter((p) => p !== prefix)) expect(await slugs(other)).toHaveLength(0);
  }));

  test('no enabled services: nothing is read', () => withHome(async () => {
    const dir = newDir('none');
    await insertSource(dir);
    const f = freshFake();
    const r = await sweep(dir, f, {}, { a_services: 'bogus' });
    expect(f.calls).toEqual({ calendar: 0, contacts: 0, mail: 0 });
    expect(r.status).toBe('up_to_date');
  }));
});

describe('apple sweep — upstream removal needs --full', () => {
  test('an incremental sweep never deletes; --full removes only what is gone from the window', () => withHome(async () => {
    const dir = newDir('full');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f);

    f.events = f.events.filter((e) => e.id !== 'evt-001');
    f.contacts = f.contacts.filter((c) => c.id !== 'con-002');
    f.mail = f.mail.filter((m) => m.threadId !== 'thr-002');

    const inc = await sweep(dir, f);
    expect(inc.deleted).toBe(0);
    expect(await slugs('calendar/')).toHaveLength(3);
    expect(await slugs('people/')).toHaveLength(4);
    expect(await slugs('emails/')).toHaveLength(2);

    const full = await sweep(dir, f, { full: true });
    expect(full.deleted).toBe(3);
    expect(await slugs('calendar/')).toHaveLength(2);
    expect(await slugs('people/')).toHaveLength(3);
    expect(await slugs('emails/')).toHaveLength(1);
    expect(await slugs('people/')).not.toContain('people/bob-example');
    // The state forgot them too, so a re-add re-imports instead of looking unchanged.
    expect(Object.keys(readAppleState(dir).contacts.hashes)).not.toContain('con-002');
    // files are gone from the managed dir as well
    expect([...walkFiles(dir)].some((p) => p.includes('bob-example'))).toBe(false);
  }));

  test('--full leaves alone events outside the listed window and threads older than the mail window', () => withHome(async () => {
    const dir = newDir('window');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f);
    // Move "now" far ahead: every stored event/thread now predates the windows.
    const cfg = parseAppleSourceConfig({ kind: 'apple', a_account: 'alice-example', a_dir: dir }, dir);
    f.events = []; f.mail = [];
    const later = NOW + 400 * 86_400_000;
    const r = await runAppleSync(engine, SID, cfg, { sourceId: SID, noEmbed: true, noExtract: true, full: true },
      { readers: readersOf(f), now: () => later, log: (m) => { logs.push(m); } });
    expect(r.deleted).toBe(0);
    expect(await slugs('calendar/')).toHaveLength(3);
    expect(await slugs('emails/')).toHaveLength(2);
  }));

  test('cancelled-after-sync event is removed by --full, kept by an incremental sweep', () => withHome(async () => {
    const dir = newDir('cancel');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f);
    f.events.find((e) => e.id === 'evt-001')!.status = 'cancelled';
    expect((await sweep(dir, f)).deleted).toBe(0);
    expect((await sweep(dir, f, { full: true })).deleted).toBe(1);
  }));

  test('--full refuses more than 200 removals, marks the run partial, deletes nothing', () => withHome(async () => {
    const dir = newDir('mass');
    await insertSource(dir);
    const f = freshFake();
    f.events = []; f.mail = [];
    f.contacts = Array.from({ length: 205 }, (_, i) => ({
      id: `bulk-${i}`, givenName: 'Person', familyName: `Number${String(i).padStart(3, '0')}`,
      emails: [`p${i}-example@example.com`], phones: [], groups: [],
    }));
    const first = await sweep(dir, f, {}, { a_services: 'contacts' });
    expect(first.added).toBe(205);

    f.contacts = [];
    const guarded = await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: undefined }, () => sweep(dir, f, { full: true }, { a_services: 'contacts' }));
    expect(guarded.status).toBe('partial');
    expect(guarded.deleted).toBe(0);
    expect(await slugs('people/')).toHaveLength(205);
    expect(logs.some((l) => l.includes('mass-delete guard refused 205'))).toBe(true);

    const allowed = await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, () => sweep(dir, f, { full: true }, { a_services: 'contacts' }));
    expect(allowed.deleted).toBe(205);
    expect(await slugs('people/')).toHaveLength(0);
  }), 120_000);

  test('exactly 200 removals are allowed without the override', () => withHome(async () => {
    const dir = newDir('edge');
    await insertSource(dir);
    const f = freshFake();
    f.events = []; f.mail = [];
    f.contacts = Array.from({ length: 200 }, (_, i) => ({
      id: `edge-${i}`, givenName: 'Edge', familyName: `Number${String(i).padStart(3, '0')}`,
      emails: [`e${i}-example@example.com`], phones: [], groups: [],
    }));
    await sweep(dir, f, {}, { a_services: 'contacts' });
    f.contacts = [];
    const r = await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: undefined }, () => sweep(dir, f, { full: true }, { a_services: 'contacts' }));
    expect(r.status).toBe('synced');
    expect(r.deleted).toBe(200);
    expect(await slugs('people/')).toHaveLength(0);
  }), 120_000);
});

describe('apple sweep — ownership', () => {
  test('a hand-authored page at a contact path is skipped, never overwritten', () => withHome(async () => {
    const dir = newDir('hand');
    await insertSource(dir);
    // Hand-authored page in the same source at people/alice-example.md.
    const { importFile } = await import('../src/core/import-file.ts');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'people'), { recursive: true });
    const handPath = join(dir, 'people', 'alice-example.md');
    writeFileSync(handPath, '---\ntype: person\ntitle: Alice by hand\n---\n\n# Alice by hand\n\nMy notes.\n');
    await importFile(engine, handPath, 'people/alice-example.md', { noEmbed: true, sourceId: SID });

    const f = freshFake();
    await sweep(dir, f);
    const hand = await engine.executeRaw<{ compiled_truth: string }>(
      `SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug='people/alice-example'`, [SID]);
    expect(hand[0].compiled_truth).toContain('My notes.');
    expect(readFileSync(handPath, 'utf-8')).toContain('My notes.');
    expect(logs.some((l) => l.includes('skipping hand-authored people/alice-example.md'))).toBe(true);
    // The other contacts still landed.
    expect(await slugs('people/')).toContain('people/bob-example');
  }));

  test('two contacts with the same name get distinct pages; the first keeps the plain slug', () => withHome(async () => {
    const dir = newDir('collide');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f, {}, { a_services: 'contacts' });
    const s = await slugs('people/');
    expect(s).toContain('people/alice-example');
    expect(s.filter((x) => /^people\/alice-example-[0-9a-f]{8}$/.test(x))).toHaveLength(1);
    const again = await sweep(dir, f, {}, { a_services: 'contacts' });
    expect(again.added + again.modified + again.deleted).toBe(0);
  }));

  test('a renamed contact moves its page (new lands, old retired)', () => withHome(async () => {
    const dir = newDir('rename');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f, {}, { a_services: 'contacts' });
    f.contacts.find((c) => c.id === 'con-002')!.givenName = 'Robert';
    const r = await sweep(dir, f, {}, { a_services: 'contacts' });
    expect(r.added).toBe(1);
    expect(r.deleted).toBe(1);
    const s = await slugs('people/');
    expect(s).toContain('people/robert-example');
    expect(s).not.toContain('people/bob-example');
  }));
});

describe('apple sweep — state file', () => {
  test('state and pages are private (0600) and private dirs', () => withHome(async () => {
    const dir = newDir('modes');
    await insertSource(dir);
    chmodSync(dir, 0o755);
    const f = freshFake();
    await sweep(dir, f);
    expect(modeOf(appleStateFile(dir))).toBe(0o600);
    const files = [...walkFiles(dir)];
    expect(files.length).toBeGreaterThan(9);
    for (const rel of files) expect(modeOf(join(dir, rel))).toBe(0o600);
    expect(files.some((p) => p.endsWith('.tmp'))).toBe(false);
    // A legacy loose state file tightens on the next write.
    chmodSync(appleStateFile(dir), 0o644);
    await sweep(dir, f);
    expect(modeOf(appleStateFile(dir))).toBe(0o600);
  }));

  test('state shape: version 1 with per-service hashes', () => withHome(async () => {
    const dir = newDir('shape');
    await insertSource(dir);
    await sweep(dir, freshFake());
    const raw = JSON.parse(readFileSync(appleStateFile(dir), 'utf-8'));
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.contacts.hashes)).toHaveLength(4);
    expect(Object.keys(raw.calendar.hashes)).toHaveLength(3);
    expect(Object.keys(raw.mail.hashes)).toHaveLength(2);
    expect(raw.calendar.window.from).toBe(new Date(NOW - 90 * 86_400_000).toISOString());
    expect(raw.mail.since).toBe(new Date(NOW - 30 * 86_400_000).toISOString());
    expect(raw.last_probe.mail.ok).toBe(true);
    // Hash values are digests, never content.
    expect(JSON.stringify(raw)).not.toContain('Please review the plan');
  }));

  test('a corrupt state file is quarantined (0600), not treated as a fresh install silently', () => withHome(async () => {
    const dir = newDir('corrupt');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f);
    writeFileSync(appleStateFile(dir), '{ this is not json', { mode: 0o644 });
    const errOrig = process.stderr.write.bind(process.stderr);
    const chunks: string[] = [];
    process.stderr.write = ((c: string | Uint8Array): boolean => { chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString()); return true; }) as typeof process.stderr.write;
    let r;
    try { r = await sweep(dir, f); } finally { process.stderr.write = errOrig; }
    const q = `${appleStateFile(dir)}.corrupt`;
    expect(existsSync(q)).toBe(true);
    expect(modeOf(q)).toBe(0o600);
    expect(chunks.join('')).toContain('was corrupt');
    // Hashes reset, but page lookup + importFile's own content check keep it idempotent.
    expect(r.added).toBe(0);
    expect(r.deleted).toBe(0);
    expect(modeOf(appleStateFile(dir))).toBe(0o600);
    expect(JSON.parse(readFileSync(appleStateFile(dir), 'utf-8')).version).toBe(1);
  }));

  test('a state file with the wrong top-level type is quarantined too', () => withHome(async () => {
    const dir = newDir('corrupt2');
    await insertSource(dir);
    await sweep(dir, freshFake());
    writeFileSync(appleStateFile(dir), '[1,2,3]');
    const errOrig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try { readAppleState(dir); } finally { process.stderr.write = errOrig; }
    expect(existsSync(`${appleStateFile(dir)}.corrupt`)).toBe(true);
  }));
});

describe('apple sweep — failures and holds', () => {
  test('a reader permission error is source-level: partial, other services still sync, never held', () => withHome(async () => {
    const dir = newDir('perm');
    await insertSource(dir);
    const f = freshFake();
    f.fail.calendar = new AppleReaderError('permission_denied', 'calendar', 'Calendar access denied', 'Enable it in System Settings');
    for (let run = 0; run < 5; run++) {
      const r = await sweep(dir, f);
      expect(r.status).toBe('partial');
      expect(r.connectorHolds).toBeUndefined();
    }
    expect(await slugs('calendar/')).toHaveLength(0);
    expect(await slugs('people/')).toHaveLength(4);
    expect(await slugs('emails/')).toHaveLength(2);
    const state = readAppleState(dir);
    expect(JSON.stringify(state.item_holds ?? {})).not.toContain('calendar');
    expect(state.last_probe!.calendar).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(state.last_probe!.contacts.ok).toBe(true);
    expect(logs.some((l) => l.includes('calendar reader failed (permission_denied)') && l.includes('Fix: Enable it in System Settings'))).toBe(true);

    // Once access is granted the service syncs; the other services' pages were untouched meanwhile.
    delete f.fail.calendar;
    const ok = await sweep(dir, f);
    expect(ok.status).toBe('synced');
    expect(ok.added).toBe(3);
    expect(readAppleState(dir).last_probe!.calendar.ok).toBe(true);
  }));

  test('a failing service does not delete or mark its existing pages gone, even with --full', () => withHome(async () => {
    const dir = newDir('failfull');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f);
    f.fail.mail = new AppleReaderError('automation_denied', 'mail', 'denied', 'allow it');
    const r = await sweep(dir, f, { full: true });
    expect(r.status).toBe('partial');
    expect(r.deleted).toBe(0);
    expect(await slugs('emails/')).toHaveLength(2);
  }));

  test('an item that fails on 3 consecutive runs is held, then stops blocking; sources unaffected', () => withHome(async () => {
    const dir = newDir('hold');
    await insertSource(dir);
    const f = freshFake();
    // NUL in an identity field (the event id) is refused with the item-scoped invalid_connector_text.
    f.events.push({ id: 'evt-bad\u0000id', calendarId: 'cal-work', calendarTitle: 'Work', title: 'Poison', start: '2026-10-23T09:00:00-07:00',
      end: '2026-10-23T10:00:00-07:00', allDay: false, attendees: [], recurring: false });

    const r1 = await sweep(dir, f);
    expect(r1.status).toBe('partial');
    expect(r1.failedFiles).toBe(1);
    expect(r1.connectorHolds).toBeUndefined();
    expect(await slugs('calendar/')).toHaveLength(3); // the good items landed

    const r2 = await sweep(dir, f);
    expect(r2.status).toBe('partial');
    expect(r2.connectorHolds).toBeUndefined();

    const r3 = await sweep(dir, f);
    expect(r3.connectorHolds).toMatchObject({ held: 1, newly_held: 1 });
    expect(r3.failedFiles).toBe(1);
    const holds = readAppleState(dir).item_holds as { items: Record<string, { state: string; attempts: number; code: string }> };
    const keys = Object.keys(holds.items);
    expect(keys).toHaveLength(1);
    expect(holds.items[keys[0]]).toMatchObject({ state: 'held', attempts: 3, code: 'invalid_connector_text' });

    // Held: the next run skips it (no new failure, not partial) and is otherwise a no-op.
    const r4 = await sweep(dir, f);
    expect(r4.failedFiles ?? 0).toBe(0);
    expect(r4.status).toBe('up_to_date');
    expect(r4.connectorHolds).toMatchObject({ held: 1, newly_held: 0 });
  }));

  test('an aborted run is partial and commits no deletions', () => withHome(async () => {
    const dir = newDir('abort');
    await insertSource(dir);
    const f = freshFake();
    await sweep(dir, f);
    f.contacts = [];
    const ac = new AbortController();
    ac.abort();
    const r = await sweep(dir, f, { full: true, signal: ac.signal });
    expect(r.status).toBe('partial');
    expect(r.deleted).toBe(0);
    expect(await slugs('people/')).toHaveLength(4);
  }));
});

describe('apple sweep — rendered pages are free of absolute home paths and real names', () => {
  test('no page or state file leaks the managed dir path', () => withHome(async () => {
    const dir = newDir('leak');
    await insertSource(dir);
    await sweep(dir, freshFake());
    for (const rel of walkFiles(dir)) {
      expect(readFileSync(join(dir, rel), 'utf-8')).not.toContain(dir);
    }
  }));
});
