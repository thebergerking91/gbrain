/**
 * `gbrain apple` (#6855): envelope shape, exit codes (0 done / 1 failed /
 * 2 waiting), the Mail confirmation gate, permission guidance and idempotent
 * registration. In-process runs inject readers, platform, engine and sync, so
 * no macOS permission or helper is ever touched; the spawned cases only use
 * paths that never reach a probe. Placeholders only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { deriveAppleSourceId, runApple, type AppleCommandDeps } from '../src/commands/apple.ts';
import type { AppleReaders, AppleService } from '../src/core/apple/types.ts';
import type { AppleReaderErrorCode } from '../src/core/apple/readers/errors.ts';

let engine: PGLiteEngine;
let home: string;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); home = mkdtempSync(join(tmpdir(), 'apple-cmd-')); });

type Probe = { ok: true } | { ok: false; code: AppleReaderErrorCode; fix: string };
function readersWith(probes: Partial<Record<AppleService, Probe>> = {}, log: AppleService[] = []): AppleReaders {
  return {
    async calendar() { throw new Error('command must not read Apple data'); },
    async contacts() { throw new Error('command must not read Apple data'); },
    async mail() { throw new Error('command must not read Apple data'); },
    async probe(service) { log.push(service); return probes[service] ?? { ok: true as const }; },
  };
}
async function run(args: string[], deps: AppleCommandDeps = {}): Promise<{ code: number; out: string; json: any }> {
  let out = '';
  const code = await runApple(args, { platform: 'darwin', engine, write: (t) => { out += t; }, ...deps });
  let json: any;
  try { json = JSON.parse(out); } catch { /* human output */ }
  return { code, out, json };
}
const okSync = async () => ({ status: 'first_sync', added: 3, modified: 0, deleted: 0 });

describe('help and parsing', () => {
  test('--help exits 0 and names every subcommand and the exit codes', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    for (const word of ['setup', 'status', 'services', '--confirm-mail', '--no-sync', 'Exit codes']) expect(r.out).toContain(word);
  });
  test('unknown subcommand and unknown flag are coded errors with exit 2', async () => {
    const a = await run(['bogus', '--json']);
    expect(a.code).toBe(2);
    expect(a.json).toMatchObject({ ok: false, status: 'error', error: { code: 'unknown_subcommand' } });
    const b = await run(['setup', '--wat', '--json']);
    expect(b.code).toBe(2);
    expect(b.json.error.code).toBe('invalid_value');
  });
});

describe('setup', () => {
  test('non-darwin: coded unsupported_platform, exit 1, nothing probed or registered', async () => {
    const probed: AppleService[] = [];
    const r = await run(['setup', '--json', '--yes'], { platform: 'linux', readers: readersWith({}, probed) });
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, status: 'error', error: { code: 'unsupported_platform' } });
    expect(Object.keys(r.json.error).sort()).toEqual(['cause', 'code', 'doc_url', 'fix', 'problem']);
    expect(probed).toEqual([]);
    expect((await engine.executeRaw('SELECT id FROM sources WHERE id LIKE $1', ['apple%'])).length).toBe(0);
  });

  test('Mail needs explicit confirmation before any probe: awaiting_confirmation, exit 2, next_action.command carries --confirm-mail', async () => {
    const probed: AppleService[] = [];
    const r = await run(['setup', '--json'], { readers: readersWith({}, probed) });
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, status: 'awaiting_confirmation' });
    expect(r.json.next_action.command).toContain('--confirm-mail');
    expect(r.json.next_action.user_message).toContain('most sensitive');
    expect(probed).toEqual([]);
    const human = await run(['setup'], { readers: readersWith() });
    expect(human.code).toBe(2);
    expect(human.out).toContain('[SHOW USER]');
    expect(human.out).toContain('[/SHOW USER]');
  });

  test('--services without mail needs no confirmation', async () => {
    const r = await run(['setup', '--json', '--services', 'calendar,contacts', '--no-sync'], { readers: readersWith() });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, status: 'ok', registered: true, services: ['calendar', 'contacts'] });
  });

  test('--yes and --confirm-mail both confirm; unknown service is a coded error, never widened', async () => {
    for (const flag of ['--yes', '--confirm-mail']) {
      await resetPgliteState(engine);
      const r = await run(['setup', '--json', flag, '--no-sync'], { readers: readersWith() });
      expect(r.code).toBe(0);
      expect(r.json.services).toEqual(['calendar', 'contacts', 'mail']);
    }
    await resetPgliteState(engine);
    const bad = await run(['setup', '--json', '--services', 'calender'], { readers: readersWith() });
    expect(bad.code).toBe(1);
    expect(bad.json.error.code).toBe('unknown_service');
    expect((await engine.executeRaw('SELECT id FROM sources WHERE id LIKE $1', ['apple%'])).length).toBe(0);
  });

  test('a denied service prints a [SHOW USER] block with the exact pane and app, status awaiting_permission, exit 2, nothing registered', async () => {
    const denied: Partial<Record<AppleService, Probe>> = {
      calendar: { ok: false, code: 'permission_denied', fix: 'Open System Settings > Privacy & Security > Calendars and enable the app.' },
      mail: { ok: false, code: 'automation_denied', fix: 'Open System Settings > Privacy & Security > Automation and enable Mail.' },
    };
    const r = await run(['setup', '--json', '--yes'], { readers: readersWith(denied) });
    expect(r.code).toBe(2);
    expect(r.json.status).toBe('awaiting_permission');
    expect(r.json.denied.map((d: any) => d.service)).toEqual(['calendar', 'mail']);
    expect(r.json.denied[0].pane).toContain('Privacy & Security > Calendars');
    expect(r.json.denied[1].pane).toContain('Automation');
    expect(r.json.next_action.command).toContain('gbrain apple setup');
    expect(r.json.next_action.user_message).toContain('Terminal');
    expect((await engine.executeRaw('SELECT id FROM sources WHERE id LIKE $1', ['apple%'])).length).toBe(0);
    const human = await run(['setup', '--yes'], { readers: readersWith(denied) });
    expect(human.code).toBe(2);
    expect(human.out).toContain('[SHOW USER]');
    expect(human.out).toContain('Privacy & Security > Calendars');
    expect(human.out).toContain('[/SHOW USER]');
  });

  test('a broken helper (not a permission) is a coded probe_failed, exit 1', async () => {
    const r = await run(['setup', '--json', '--services', 'contacts'], { readers: readersWith({ contacts: { ok: false, code: 'helper_failed', fix: 'Install the Command Line Tools.' } }) });
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('probe_failed');
  });

  test('all probes pass: registers once, runs the budgeted first sync, and a re-run is idempotent', async () => {
    const synced: string[] = [];
    const sync = async (_e: unknown, o: { sourceId: string; signal: AbortSignal }) => { synced.push(o.sourceId); expect(o.signal.aborted).toBe(false); return okSync(); };
    const first = await run(['setup', '--json', '--yes', '--account', 'alice-example'], { readers: readersWith(), sync: sync as never });
    expect(first.code).toBe(0);
    expect(first.json).toMatchObject({ ok: true, status: 'ok', source_id: 'apple-alice-example', registered: true, sync: { status: 'first_sync', added: 3 } });
    const second = await run(['setup', '--json', '--yes', '--account', 'alice-example'], { readers: readersWith(), sync: sync as never });
    expect(second.code).toBe(0);
    expect(second.json).toMatchObject({ registered: false, already_registered: true, source_id: 'apple-alice-example' });
    expect(synced).toEqual(['apple-alice-example', 'apple-alice-example']);
    expect((await engine.executeRaw('SELECT id FROM sources WHERE id LIKE $1', ['apple%'])).length).toBe(1);
  });

  test('--no-sync registers without syncing; a sync failure is a coded error but the source stays registered', async () => {
    const never = async () => { throw new Error('must not sync'); };
    const a = await run(['setup', '--json', '--yes', '--no-sync'], { readers: readersWith(), sync: never as never });
    expect(a.json.sync).toBeUndefined();
    expect(a.json.next_action.command).toBe('gbrain sync --source apple-local');
    const b = await run(['setup', '--json', '--yes'], { readers: readersWith(), sync: (async () => { throw new Error('boom'); }) as never });
    expect(b.code).toBe(1);
    expect(b.json.error.code).toBe('sync_failed');
    expect((await engine.executeRaw('SELECT id FROM sources WHERE id=$1', ['apple-local'])).length).toBe(1);
  });

  test('a source id used by a non-apple source is refused, not overwritten', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('apple-local', 'x', '/tmp/x', '{}'::jsonb)`);
    const r = await run(['setup', '--json', '--yes', '--no-sync'], { readers: readersWith() });
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe('source_id_taken');
  });

  test('the command only probes: reader data methods are never called', async () => {
    const r = await run(['setup', '--json', '--yes'], { readers: readersWith(), sync: okSync as never });
    expect(r.code).toBe(0);
  });

  test('deriveAppleSourceId yields valid ids', () => {
    expect(deriveAppleSourceId('local')).toBe('apple-local');
    expect(deriveAppleSourceId('Work Laptop!')).toBe('apple-work-laptop');
    expect(deriveAppleSourceId('x'.repeat(80)).length).toBeLessThanOrEqual(32);
  });
});

describe('status and services', () => {
  async function register(services?: string) {
    await run(['setup', '--json', '--yes', '--no-sync', ...(services ? ['--services', services] : [])], { readers: readersWith() });
  }

  test('no source: not_configured, exit 1', async () => {
    const r = await run(['status', '--json']);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, status: 'not_configured', next_action: { command: 'gbrain apple setup' } });
  });

  test('live probes: all readable -> exit 0; an enabled unreadable service -> ok:false, exit 1 with the fix; a disabled one is not probed', async () => {
    await register('calendar,contacts');
    const probed: AppleService[] = [];
    const good = await run(['status', '--json'], { readers: readersWith({}, probed) });
    expect(good.code).toBe(0);
    expect(good.json.ok).toBe(true);
    expect(good.json.sources[0].services.mail).toEqual({ enabled: false });
    expect(probed.sort()).toEqual(['calendar', 'contacts']);
    const bad = await run(['status', '--json'], { readers: readersWith({ contacts: { ok: false, code: 'permission_denied', fix: 'grant it' } }) });
    expect(bad.code).toBe(1);
    expect(bad.json).toMatchObject({ ok: false, status: 'degraded' });
    expect(bad.json.sources[0].services.contacts).toMatchObject({ ok: false, code: 'permission_denied', fix: 'grant it' });
    expect(bad.json.sources[0].services.contacts.pane).toContain('Contacts');
  });

  test('--no-probe runs no helper and reports the last recorded probe', async () => {
    await register('contacts');
    const [src] = await engine.executeRaw<{ local_path: string }>("SELECT local_path FROM sources WHERE id='apple-local'");
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(src!.local_path, { recursive: true });
    writeFileSync(join(src!.local_path, '.apple-source.json'), JSON.stringify({ version: 1, calendar: { hashes: {} }, contacts: { hashes: {} }, mail: { hashes: {} },
      last_probe: { contacts: { ok: false, at: '2026-10-16T00:00:00Z', code: 'permission_denied' } } }));
    const probed: AppleService[] = [];
    const r = await run(['status', '--json', '--no-probe'], { readers: readersWith({}, probed) });
    expect(probed).toEqual([]);
    expect(r.code).toBe(1);
    expect(r.json.sources[0].services.contacts).toMatchObject({ ok: false, live: false, code: 'permission_denied' });
    expect(r.json.sources[0]).toMatchObject({ held_items: 0, last_sync_at: null });
  });

  test('services lists enabled and disabled; names unknown, non-apple and ambiguous sources as coded errors', async () => {
    await register('calendar,mail');
    const r = await run(['services', 'apple-local', '--json']);
    expect(r.code).toBe(0);
    expect(r.json.services).toEqual([{ service: 'calendar', enabled: true }, { service: 'contacts', enabled: false }, { service: 'mail', enabled: true }]);
    expect((await run(['services', 'nope', '--json'])).json.error.code).toBe('source_not_found');
    expect((await run(['services', 'default', '--json'])).json.error.code).toBe('not_apple_source');
    await run(['setup', '--json', '--yes', '--no-sync', '--account', 'second', '--services', 'contacts'], { readers: readersWith() });
    const ambiguous = await run(['services', '--json']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.json.error.code).toBe('ambiguous_source');
  });
});

describe('spawned CLI', () => {
  test('apple --help and an unconfigured status --json: envelope and exit codes through the real entrypoint', async () => {
    const help = await runCli(['apple', '--help'], { home });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('gbrain apple');
    const status = await runCli(['apple', 'status', '--json'], { home });
    expect(status.exitCode).toBe(1);
    const envelope = JSON.parse(status.stdout);
    expect(envelope).toMatchObject({ ok: false, status: 'not_configured', next_action: { command: 'gbrain apple setup' } });
  });

  test('apple setup --json never reaches a probe without consent: Mail gate on macOS, unsupported_platform elsewhere', async () => {
    const r = await runCli(['apple', 'setup', '--json'], { home });
    const envelope = JSON.parse(r.stdout);
    if (process.platform === 'darwin') {
      expect(r.exitCode).toBe(2);
      expect(envelope.status).toBe('awaiting_confirmation');
    } else {
      expect(r.exitCode).toBe(1);
      expect(envelope.error.code).toBe('unsupported_platform');
    }
  });

  test('unknown subcommand through the entrypoint exits 2 with a coded envelope', async () => {
    const r = await runCli(['apple', 'wat', '--json'], { home });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe('unknown_subcommand');
  });
});
