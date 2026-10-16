/**
 * apple-readers — hermetic tests for the Apple connector's reader layer.
 *
 * run-helper is exercised against a tiny fake helper (a node script in a temp
 * dir), so everything runs on any OS. The real Swift/JXA helpers are only
 * type/syntax-checked (darwin); they are NOT run here, so nothing in this file
 * verifies them against real Calendar/Contacts/Mail data. Placeholder data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { AppleReaderError, fixFor } from '../src/core/apple/readers/errors.ts';
import { runHelper, scrubEnv, MAX_STDERR_BYTES } from '../src/core/apple/readers/run-helper.ts';
import { createAppleReaders } from '../src/core/apple/readers/index.ts';
import { CALENDAR_SCRIPT, normalizeEvent } from '../src/core/apple/readers/calendar.ts';
import { CONTACTS_SCRIPT, normalizeContact } from '../src/core/apple/readers/contacts.ts';
import { MAIL_SCRIPT, MAIL_BODY_CAP, normalizeMessage } from '../src/core/apple/readers/mail.ts';

let dir = '';
let fake = '';

const FAKE = `
const mode = process.argv[2];
const out = (s) => process.stdout.write(s);
switch (mode) {
  case 'ok': out(JSON.stringify({ items: [{ id: 'alice-example-1' }] })); break;
  case 'ok-noitems': out(JSON.stringify({ other: 1 })); break;
  case 'error-json':
    out(JSON.stringify({ error: { code: 'permission_denied', message: 'no access for alice-example' } }));
    process.exit(1); break;
  case 'error-json-unknown-code':
    out(JSON.stringify({ error: { code: 'weird', message: 'boom' } }));
    process.exit(1); break;
  case 'error-json-exit0':
    out(JSON.stringify({ error: { code: 'automation_denied', message: 'no' } })); break;
  case 'crash': process.stderr.write('x'.repeat(5000)); process.exit(7); break;
  case 'malformed': out('{not json'); break;
  case 'garbage-exit1': out('hello'); process.exit(1); break;
  case 'hang': setInterval(() => {}, 1000); break;
  case 'flood': { const b = 'a'.repeat(65536); const t = setInterval(() => out(b), 0); break; }
  case 'env': out(JSON.stringify({ items: [Object.keys(process.env).sort()] })); break;
  case 'args': out(JSON.stringify({ items: [process.argv.slice(3)] })); break;
}
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'apple-readers-'));
  fake = join(dir, 'fake-helper.js');
  writeFileSync(fake, FAKE);
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function run(mode: string, extra: Partial<Parameters<typeof runHelper>[0]> = {}) {
  return runHelper({
    service: 'calendar',
    command: process.execPath,
    args: [fake, mode],
    platform: 'darwin',
    ...extra,
  });
}

async function fails(p: Promise<unknown>): Promise<AppleReaderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppleReaderError);
    return e as AppleReaderError;
  }
  throw new Error('expected rejection');
}

describe('runHelper', () => {
  test('success returns items', async () => {
    expect(await run('ok')).toEqual([{ id: 'alice-example-1' }]);
  });

  test('success without items array is malformed_output', async () => {
    expect((await fails(run('ok-noitems'))).code).toBe('malformed_output');
  });

  test('error JSON maps to code, message and an actionable fix', async () => {
    const e = await fails(run('error-json'));
    expect(e.code).toBe('permission_denied');
    expect(e.service).toBe('calendar');
    expect(e.message).toContain('no access for alice-example');
    expect(e.fix).toContain('Privacy & Security');
    expect(e.fix).toContain('Calendars');
  });

  test('unknown error code collapses to helper_failed', async () => {
    expect((await fails(run('error-json-unknown-code'))).code).toBe('helper_failed');
  });

  test('error document wins even with exit 0', async () => {
    expect((await fails(run('error-json-exit0'))).code).toBe('automation_denied');
  });

  test('non-zero exit without JSON is helper_failed with truncated stderr', async () => {
    const e = await fails(run('crash'));
    expect(e.code).toBe('helper_failed');
    expect(e.message).toContain('code 7');
    expect(e.message).toContain('[truncated]');
    expect(e.message.length).toBeLessThan(MAX_STDERR_BYTES + 300);
  });

  test('non-zero exit with non-JSON stdout is helper_failed', async () => {
    expect((await fails(run('garbage-exit1'))).code).toBe('helper_failed');
  });

  test('malformed JSON on exit 0 is malformed_output', async () => {
    expect((await fails(run('malformed'))).code).toBe('malformed_output');
  });

  test('timeout is helper_timeout', async () => {
    const t0 = Date.now();
    const e = await fails(run('hang', { timeoutMs: 300 }));
    expect(e.code).toBe('helper_timeout');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  test('stdout over the cap is malformed_output and the child is killed', async () => {
    const e = await fails(run('flood', { maxStdoutBytes: 100_000, timeoutMs: 20_000 }));
    expect(e.code).toBe('malformed_output');
    expect(e.message).toContain('cap');
  });

  test('abort signal stops the helper', async () => {
    const ac = new AbortController();
    const p = run('hang', { signal: ac.signal, timeoutMs: 20_000 });
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const e = await fails(p);
    expect(e.code).toBe('helper_failed');
    expect(e.message).toContain('aborted');
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  test('already-aborted signal never spawns', async () => {
    const ac = new AbortController();
    ac.abort();
    expect((await fails(run('ok', { signal: ac.signal }))).message).toContain('aborted');
  });

  test('environment is scrubbed to PATH/HOME/TMPDIR/LANG', async () => {
    const env = {
      PATH: process.env.PATH ?? '/usr/bin',
      HOME: '/tmp/alice-example-home',
      TMPDIR: dir,
      LANG: 'en_US.UTF-8',
      SECRET_TOKEN: 'should-not-leak',
      OPENAI_API_KEY: 'should-not-leak',
    };
    const [keys] = (await run('env', { env })) as string[][];
    expect(keys.filter((k) => !['PATH', 'HOME', 'TMPDIR', 'LANG', 'PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'].includes(k))).toEqual([]);
    expect(keys).not.toContain('SECRET_TOKEN');
    expect(keys).not.toContain('OPENAI_API_KEY');
    expect(scrubEnv(env)).toEqual({ PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, LANG: env.LANG });
  });

  test('args are passed as an argv array, never through a shell', async () => {
    const evil = 'a b; touch /tmp/pwned-alice-example $(id)';
    const [argv] = (await run('args', { args: [fake, 'args', evil, '--x'] })) as string[][];
    expect(argv).toEqual([evil, '--x']);
  });

  test('missing executable is helper_failed', async () => {
    const e = await fails(run('ok', { command: join(dir, 'does-not-exist') }));
    expect(e.code).toBe('helper_failed');
  });

  test('non-darwin returns unsupported_platform before spawning', async () => {
    const e = await fails(run('ok', { platform: 'linux' }));
    expect(e.code).toBe('unsupported_platform');
    expect(e.fix).toContain('macOS');
  });
});

describe('fix strings', () => {
  test('name the pane and the app to grant, and do not claim verification', () => {
    expect(fixFor('permission_denied', 'contacts')).toContain('Privacy & Security > Contacts');
    expect(fixFor('permission_denied', 'calendar')).toContain('Privacy & Security > Calendars');
    const a = fixFor('automation_denied', 'mail');
    expect(a).toContain('Privacy & Security > Automation');
    expect(a).toContain('"Mail"');
    expect(fixFor('mail_not_running_or_unconfigured', 'mail')).toContain('Mail.app');
    for (const c of ['unsupported_platform', 'permission_denied', 'helper_failed', 'helper_timeout', 'malformed_output', 'automation_denied', 'mail_not_running_or_unconfigured'] as const) {
      expect(fixFor(c, 'calendar').length).toBeGreaterThan(20);
      expect(fixFor(c, 'calendar').toLowerCase()).not.toContain('verified');
    }
  });
});

describe('createAppleReaders with a fake helper', () => {
  const fakeOverrides = (mode: string) => ({ command: process.execPath, scriptArgs: [fake, mode], platform: 'darwin' as const });

  test('non-darwin: every reader rejects with unsupported_platform; probe reports it', async () => {
    const r = createAppleReaders({ platform: 'linux' });
    const now = new Date();
    expect((await fails(r.calendar({ from: now, to: now, calendarIds: [] }))).code).toBe('unsupported_platform');
    expect((await fails(r.contacts({}))).code).toBe('unsupported_platform');
    expect((await fails(r.mail({ since: now, mailboxes: ['INBOX'] }))).code).toBe('unsupported_platform');
    for (const s of ['calendar', 'contacts', 'mail'] as const) {
      const p = await r.probe(s);
      expect(p.ok).toBe(false);
      if (!p.ok) {
        expect(p.code).toBe('unsupported_platform');
        expect(p.fix.length).toBeGreaterThan(10);
      }
    }
  });

  test('probe maps helper error to code + fix; ok maps to ok', async () => {
    const bad = await createAppleReaders(fakeOverrides('error-json')).probe('contacts');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe('permission_denied');
      expect(bad.fix).toContain('Contacts');
    }
    expect(await createAppleReaders(fakeOverrides('ok')).probe('mail')).toEqual({ ok: true });
  });

  test('calendar/contacts/mail normalize helper items', async () => {
    const ev = normalizeEvent({
      id: 'e1', calendarId: 'c1', calendarTitle: 'Work', title: 'Sync alice-example', start: '2026-01-02T10:00:00Z',
      end: '2026-01-02T11:00:00Z', allDay: false, attendees: [{ name: 'Alice Example', email: 'alice-example@example.com' }, {}], recurring: true, junk: 1,
    });
    expect(ev.attendees).toEqual([{ name: 'Alice Example', email: 'alice-example@example.com' }]);
    expect(ev.recurring).toBe(true);
    expect(() => normalizeEvent({ id: 'x' })).toThrow(AppleReaderError);

    const c = normalizeContact({ id: 'p1', givenName: 'Alice', emails: ['alice-example@example.com', 5], phones: [], groups: ['acme-example'] });
    expect(c).toEqual({ id: 'p1', givenName: 'Alice', emails: ['alice-example@example.com'], phones: [], groups: ['acme-example'] });
    expect(() => normalizeContact({})).toThrow(AppleReaderError);

    const m = normalizeMessage({ id: 'm1', date: '2026-01-02T10:00:00Z', body: 'x'.repeat(MAIL_BODY_CAP + 50), to: ['alice-example@example.com'] });
    expect(m.body.length).toBe(MAIL_BODY_CAP);
    expect(m.threadId).toBe('m1');
    expect(m.cc).toEqual([]);
    expect(() => normalizeMessage({ id: 'm1' })).toThrow(AppleReaderError);
  });

  test('a reader with a malformed item reports malformed_output', async () => {
    const r = createAppleReaders(fakeOverrides('ok')); // items: [{id}] lacks start/end
    const e = await fails(r.calendar({ from: new Date(0), to: new Date(1000), calendarIds: [] }));
    expect(e.code).toBe('malformed_output');
  });
});

describe.skipIf(process.platform !== 'darwin')('helper scripts compile (darwin only; NOT run against real data)', () => {
  for (const [name, script] of [['calendar.swift', CALENDAR_SCRIPT], ['contacts.swift', CONTACTS_SCRIPT]] as const) {
    test(`swiftc -typecheck ${name}`, () => {
      const r = spawnSync('/usr/bin/swiftc', ['-typecheck', script], { encoding: 'utf8', timeout: 120_000 });
      if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return; // no Command Line Tools
      expect(r.stderr || '').not.toContain('error:');
      expect(r.status).toBe(0);
    }, 120_000);
  }

  test('mail.js compiles with osacompile (syntax only; Mail is not launched)', () => {
    const out = join(dir, 'mail.scpt');
    const r = spawnSync('/usr/bin/osacompile', ['-l', 'JavaScript', '-o', out, MAIL_SCRIPT], { encoding: 'utf8', timeout: 60_000 });
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return;
    expect(r.stderr || '').toBe('');
    expect(r.status).toBe(0);
  });
});
