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

// ── #2 embedded scripts, #1 not-determined, #9 old macOS, #4/#8 mail listing ───────────────────────────────

describe('embedded helper scripts (compiled-binary safe)', () => {
  test('the embedded text equals the bytes of scripts/apple/*, the single source of truth', async () => {
    const { CALENDAR_SWIFT_TEXT, CONTACTS_SWIFT_TEXT, MAIL_JS_TEXT } = await import('../src/core/apple/readers/embedded-scripts.ts');
    const { readFileSync } = await import('node:fs');
    expect(CALENDAR_SWIFT_TEXT).toBe(readFileSync(CALENDAR_SCRIPT, 'utf8'));
    expect(CONTACTS_SWIFT_TEXT).toBe(readFileSync(CONTACTS_SCRIPT, 'utf8'));
    expect(MAIL_JS_TEXT).toBe(readFileSync(MAIL_SCRIPT, 'utf8'));
    expect(CALENDAR_SWIFT_TEXT.length).toBeGreaterThan(1000);
  });

  test('a bundle inlines the scripts (no import.meta.url file path is needed at run time)', async () => {
    const out = await Bun.build({ entrypoints: [join(import.meta.dir, '..', 'src/core/apple/readers/embedded-scripts.ts')], target: 'bun' });
    expect(out.success).toBe(true);
    const text = await out.outputs[0]!.text();
    expect(text).toContain('requestFullAccessToEvents');
    expect(text).toContain('enumerateContacts');
    expect(text).toContain("Application('Mail')");
  });

  test('withHelperScript writes a private 0700 dir with a 0600 file, unique per run, and removes it afterwards (also on throw)', async () => {
    const { withHelperScript, HELPER_SCRIPT_TEXT } = await import('../src/core/apple/readers/embedded-scripts.ts');
    const { readFileSync, statSync, existsSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const seen: string[] = [];
    await withHelperScript('mail.js', async (p) => {
      seen.push(p);
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(p)).mode & 0o777).toBe(0o700);
      expect(readFileSync(p, 'utf8')).toBe(HELPER_SCRIPT_TEXT['mail.js']);
    });
    await withHelperScript('mail.js', async (p) => { seen.push(p); });
    await withHelperScript('contacts.swift', async () => { throw new Error('boom'); }).catch(() => {});
    expect(new Set(seen).size).toBe(2);
    for (const p of seen) expect(existsSync(dirname(p))).toBe(false);
  });

  test('a reader with no scriptArgs override runs the interpreter on a temp copy of the embedded script, then removes it', async () => {
    // A fake interpreter: prints its first argument (the script path it was handed) as the contact id.
    const interp = join(dir, 'fake-interp.sh');
    writeFileSync(interp, '#!/bin/sh\nprintf \'{"items":[{"id":"%s"}]}\' "$1"\n', { mode: 0o755 });
    const [c] = await createAppleReaders({ command: interp, platform: 'darwin' }).contacts({});
    const { existsSync } = await import('node:fs');
    expect(c!.id.endsWith('/contacts.swift')).toBe(true);
    expect(c!.id).not.toBe(CONTACTS_SCRIPT); // not the source-tree (or /$bunfs) path
    expect(existsSync(c!.id)).toBe(false); // removed after the run
  });
});

describe('permission_not_determined, selection_not_found, macos_too_old', () => {
  test('are codes with their own fix text, distinct from permission_denied', () => {
    const nd = fixFor('permission_not_determined', 'calendar');
    expect(nd).toContain('not a denial');
    expect(nd).not.toBe(fixFor('permission_denied', 'calendar'));
    expect(fixFor('selection_not_found', 'mail')).toContain('mailbox');
    expect(fixFor('selection_not_found', 'calendar')).toContain('calendar id');
    expect(fixFor('macos_too_old', 'calendar')).toContain('macOS 14');
    expect(fixFor('macos_too_old', 'calendar')).toContain('Command Line Tools 15');
  });

  test('a helper error document with permission_not_determined keeps its code through probe', async () => {
    const script = join(dir, 'nd.js');
    writeFileSync(script, "process.stdout.write(JSON.stringify({error:{code:'permission_not_determined',message:'not asked'}}));process.exit(1)");
    const p = await createAppleReaders({ command: process.execPath, scriptArgs: [script], platform: 'darwin' }).probe('contacts');
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe('permission_not_determined');
  });

  test('swiftc availability errors on stderr map to macos_too_old with a fix, not a cryptic compile error', async () => {
    const script = join(dir, 'old.js');
    writeFileSync(script, "process.stderr.write('error: x.swift:3: error: \\'requestFullAccessToEvents\\' is only available in macOS 14.0 or newer\\n');process.exit(1)");
    const p = await createAppleReaders({ command: process.execPath, scriptArgs: [script], platform: 'darwin' }).probe('calendar');
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.code).toBe('macos_too_old');
      expect(p.fix).toContain('macOS 14');
    }
  });

  test('the availability text is found even when it is past the 2 KB shown in messages', async () => {
    const script = join(dir, 'old-late.js');
    writeFileSync(script, "process.stderr.write('x'.repeat(5000)+' is only available in macOS 14.0');process.exit(1)");
    const e = await fails(runHelper({ service: 'calendar', command: process.execPath, args: [script], platform: 'darwin' }));
    expect(e.code).toBe('macos_too_old');
    expect(e.message.length).toBeLessThan(MAX_STDERR_BYTES + 400);
  });

  test('requestAccess maps a helper failure to a code and success to ok', async () => {
    const okScript = join(dir, 'ra-ok.js');
    writeFileSync(okScript, "process.stdout.write(JSON.stringify({items:[]}))");
    const ok = await createAppleReaders({ command: process.execPath, scriptArgs: [okScript], platform: 'darwin' }).requestAccess!('calendar');
    expect(ok).toEqual({ ok: true });
    const badScript = join(dir, 'ra-bad.js');
    writeFileSync(badScript, "process.stdout.write(JSON.stringify({error:{code:'permission_denied',message:'no'}}));process.exit(1)");
    const bad = await createAppleReaders({ command: process.execPath, scriptArgs: [badScript], platform: 'darwin' }).requestAccess!('contacts');
    expect(bad.ok).toBe(false);
  });
});

describe('mail listing document', () => {
  test('truncated / unavailable / incomplete flow through; a bare array stays "complete"', async () => {
    const script = join(dir, 'mail-doc.js');
    writeFileSync(script, `process.stdout.write(JSON.stringify({items:[{id:'m1',date:'2026-01-02T10:00:00Z'}],truncated:true,unavailable:['t-bad'],incomplete:true,args:process.argv.slice(2)}))`);
    const r = createAppleReaders({ command: process.execPath, scriptArgs: [script], platform: 'darwin' });
    const listing = await r.mail({ since: new Date(0), mailboxes: ['INBOX'], max: 7 });
    expect(Array.isArray(listing)).toBe(false);
    if (!Array.isArray(listing)) {
      expect(listing.messages.map((m) => m.id)).toEqual(['m1']);
      expect(listing.truncated).toBe(true);
      expect(listing.unavailableThreads).toEqual(['t-bad']);
      expect(listing.incomplete).toBe(true);
    }
  });

  test('--max is passed to the helper', async () => {
    const script = join(dir, 'mail-args.js');
    writeFileSync(script, `process.stdout.write(JSON.stringify({items:[{id:'m1',date:'2026-01-02T10:00:00Z',subject:process.argv.slice(2).join(' ')}]}))`);
    const r = createAppleReaders({ command: process.execPath, scriptArgs: [script], platform: 'darwin' });
    const listing = await r.mail({ since: new Date(0), mailboxes: ['INBOX'], max: 7 });
    const messages = Array.isArray(listing) ? listing : listing.messages;
    expect(messages[0]!.subject).toContain('--max 7');
  });
});

describe('helper scripts: source-level guards (static; the scripts are not run here)', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  test('mail.js never launches Mail: running() gates probe and sync, and NSWorkspace is gone', () => {
    const js = readFileSync(MAIL_SCRIPT, 'utf8');
    expect(js).toContain('Mail.running()');
    expect(js).not.toContain('NSWorkspace');
    const run = js.slice(js.indexOf('function run(argv)'));
    expect(run.indexOf('Mail.running()')).toBeGreaterThan(0);
    expect(run.indexOf('Mail.running()')).toBeLessThan(run.indexOf('Mail.accounts()'));
    expect(run.indexOf('args.probe')).toBeGreaterThan(run.indexOf('Mail.running()')); // the check precedes the probe branch
    expect(js).not.toContain('byId');
  });
  test('swift helpers separate not-determined from denied and honour --request-access', () => {
    for (const f of [CALENDAR_SCRIPT, CONTACTS_SCRIPT]) {
      const swift = readFileSync(f, 'utf8');
      expect(swift).toContain('permission_not_determined');
      expect(swift).toContain('--request-access');
    }
    expect(readFileSync(CALENDAR_SCRIPT, 'utf8')).toContain('selection_not_found');
    expect(readFileSync(CALENDAR_SCRIPT, 'utf8')).toContain('.birthday');
    expect(readFileSync(CALENDAR_SCRIPT, 'utf8')).toContain('calendarItemExternalIdentifier');
  });
});
