/**
 * Managed-persistence path of the Apple connector (#6855): importMarkdown,
 * delete, saveState and assertAccount through ManagedConnectorSync, on the
 * real persistence owner (PGLite, plus Postgres when the harness provides it).
 * Modeled on google-managed-delta-abort. Fake readers; synthetic data only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { runAppleSync } from '../src/core/apple/apple-source.ts';
import { parseAppleSourceConfig } from '../src/core/apple/source-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readManagedConnectorState } from '../src/core/persistence/connector-state.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, sourceCheckpoint } from './helpers/connector-fixture.ts';
import type { AppleContact, AppleReaders } from '../src/core/apple/types.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const person = (id: string, given: string): AppleContact => ({ id, givenName: given, familyName: 'Example', emails: [`${id}@example.com`], phones: [], groups: [] });

function readers(state: { contacts: AppleContact[] }): AppleReaders {
  return {
    async calendar() { return []; },
    async contacts() { return structuredClone(state.contacts); },
    async mail() { return []; },
    async probe() { return { ok: true as const }; },
  };
}

test('managed apple sweep: pages land via importMarkdown, the cursor lands via saveState, the account is pinned, and a --full sweep deletes through the managed path', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { kind: 'apple', a_account: 'alice-example', a_services: 'contacts' };
    const f = await source(engine, config);
    const cfg = parseAppleSourceConfig({ ...config, a_dir: f.dir }, f.dir);
    const state = { contacts: [person('c-1', 'Alice'), person('c-2', 'Bob')] };
    const run = (extra = {}) => runAppleSync(engine, f.id, cfg, { ...options, sourceId: f.id, ...extra }, { readers: readers(state), log: () => {} });
    const imports = async () => (await engine.executeRaw<{ slug: string }>(
      "SELECT DISTINCT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_import' ORDER BY slug", [f.id])).map((r) => r.slug);
    const deletes = async () => (await engine.executeRaw<{ slug: string }>(
      "SELECT DISTINCT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_delete' ORDER BY slug", [f.id])).map((r) => r.slug);

    // First sweep: importMarkdown for each contact through the owner.
    const first = await run();
    expect(first.status).toBe('first_sync');
    expect(first.added).toBe(2);
    expect(await imports()).toEqual(['people/alice-example', 'people/bob-example']);

    // assertAccount: the label is pinned in the connector state row.
    const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [f.id]);
    const pinned = await readManagedConnectorState(engine, f.id, row!.incarnation);
    expect(pinned.account).toEqual({ kind: 'apple', account: 'alice-example' });

    // saveState: the hash cursor was committed with the checkpoint.
    await disposePersistenceConsumer(engine);
    const [cp] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: { contacts?: { hashes: Record<string, string> }; last_probe?: Record<string, { ok: boolean }> } }[] }[];
    expect(Object.keys(cp!.completed_keys[0]!.state!.contacts!.hashes)).toHaveLength(2);
    expect(cp!.completed_keys[0]!.state!.last_probe!.contacts!.ok).toBe(true);

    // Idempotent rerun: nothing added or modified.
    const again = await run();
    expect(again.added + again.modified + again.deleted).toBe(0);

    // An incremental sweep never deletes; a --full sweep deletes the vanished contact through the managed path.
    state.contacts = [person('c-1', 'Alice')];
    const incremental = await run();
    expect(incremental.deleted).toBe(0);
    expect(await deletes()).toEqual([]);
    const full = await run({ full: true });
    expect(full.deleted).toBe(1);
    expect(await deletes()).toEqual(['people/bob-example']);
    const live = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug", [f.id]);
    expect(live.map((p) => p.slug)).toEqual(['people/alice-example']);
  }
}), 180_000);

test('managed apple sweep: a re-pointed account label is refused (connector_account_changed) and imports nothing', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { kind: 'apple', a_account: 'alice-example', a_services: 'contacts' };
    const f = await source(engine, config);
    const state = { contacts: [person('c-1', 'Alice')] };
    const cfg = parseAppleSourceConfig({ ...config, a_dir: f.dir }, f.dir);
    await runAppleSync(engine, f.id, cfg, { ...options, sourceId: f.id }, { readers: readers(state), log: () => {} });

    // Same source, label changed in the stored config: the pinned account no longer matches.
    await engine.executeRaw("UPDATE sources SET config = config || '{\"a_account\":\"someone-else\"}'::jsonb WHERE id=$1", [f.id]);
    const moved = parseAppleSourceConfig({ ...config, a_account: 'someone-else', a_dir: f.dir }, f.dir);
    state.contacts = [person('c-1', 'Alice'), person('c-9', 'Zed')];
    const refused = await runAppleSync(engine, f.id, moved, { ...options, sourceId: f.id }, { readers: readers(state), log: () => {} }).then(() => null, (e: Error & { code?: string }) => e);
    expect(refused?.code).toBe('connector_account_changed');
    const pages = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug", [f.id]);
    expect(pages.map((p) => p.slug)).not.toContain('people/zed-example');
  }
}), 180_000);
