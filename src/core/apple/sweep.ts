/**
 * apple sweep — the Contacts, Calendar and Mail sweeps of the apple source
 * kind. Each sweep:
 *
 *   1. asks the injected reader for the configured window (a reader error is
 *      SOURCE-level: it propagates, commits nothing for that service, and is
 *      never counted toward an item hold);
 *   2. renders every item deterministically and hash-diffs it against the
 *      state (`id → sha256(path + markdown)`); an unchanged item whose page is
 *      still there costs nothing, so an identical rerun adds/modifies 0;
 *   3. writes changed items through the item holds: an item whose render or
 *      import fails on 3 consecutive runs is held and no longer blocks the run;
 *   4. on `--full` only, removes the pages of items inside the window that the
 *      complete listing no longer names. An incremental sweep never deletes
 *      anything upstream stopped listing (a staged rename of one item's own
 *      page excepted). More than 200 removals at once, or ANY removal when the
 *      listing came back EMPTY, needs GBRAIN_ALLOW_MASS_RECONCILE=1; a refusal
 *      removes nothing and marks the run partial. A listing the reader flags
 *      as cut short or unreadable (mail truncation, unreadable messages) never
 *      deletes either.
 *
 * Ownership is keyed on the marker frontmatter field (`apple_event_id`,
 * `apple_contact_id`, `apple_thread_id`), never on the path alone: a
 * hand-authored page at a contact's path is skipped, never overwritten.
 */
import type { ConnectorHoldSession } from '../connectors/connector-hold-session.ts';
import { massReconcileAllowed } from '../sync-reconcile.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import {
  calendarItemKey,
  contactDisplayName,
  renderedHash,
  groupMailThreads,
  mailPriorFromPage,
  personSlugFromContact,
  renderCalendarEventPage,
  renderMailThreadPage,
  renderPersonPage,
  type RenderedPage,
} from './render.ts';
import {
  deletePageByRelPath,
  importRendered,
  loadLivePaths,
  loadOwnedPages,
  type ActivePack,
  type AppleSyncDeps,
  type AppleSyncSummary,
} from './sweep-shared.ts';
import { appleLoopsAvailability } from './loops-status.ts';
import { prepareLoopsState, trackMailLoops, type AppleLoopsRun } from './loops.ts';
import type { AppleCalendarEvent, AppleContact, AppleMailListing, AppleSourceState } from './types.ts';

const DAY_MS = 86_400_000;

/** Removals one `--full` reconcile may make without GBRAIN_ALLOW_MASS_RECONCILE=1. */
export const APPLE_MASS_RECONCILE_LIMIT = 200;

export interface AppleSweepCtx {
  deps: AppleSyncDeps;
  state: AppleSourceState;
  activePack: ActivePack;
  summary: AppleSyncSummary;
  countedSlugs: Set<string>;
  holds: ConnectorHoldSession;
  /** Open-loop bookkeeping for this run; present only when Mail loop tracking is available (owner addresses set). */
  loops?: AppleLoopsRun;
}

const byId = <T,>(key: (x: T) => string) => (a: T, b: T): number => {
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── Item holds ───────────────────────────────────────────────────────────────

/** Counts one item failure (hold bookkeeping, summary, log). Managed write errors are rethrown by the hold session. */
async function failItem(ctx: AppleSweepCtx, holdKey: string, error: unknown, version: string | null, page: RenderedPage | null): Promise<void> {
  const { deps, summary, holds } = ctx;
  const wasHeld = holds.isHeld(holdKey);
  const classified = await holds.fail(holdKey, error, { version, slug: page ? page.relPath.replace(/\.md$/, '') : null });
  summary.failedFiles++;
  deps.log(`[apple] ${holdKey} failed${classified.scope === 'rate_limit' ? ' (rate limited; not counted toward a hold)' : ''}: ${messageOf(error)}`);
  // A held item that fails again after being re-admitted does not make the run partial.
  if (!wasHeld || classified.scope === 'rate_limit') summary.status = 'partial';
}

/** One item through the holds. True when it was written. */
async function attemptItem(ctx: AppleSweepCtx, holdKey: string, version: string, page: RenderedPage, work: () => Promise<void>): Promise<boolean> {
  if (!ctx.holds.shouldAttempt(holdKey, version)) {
    ctx.deps.tick(`${holdKey} held`);
    return false;
  }
  try {
    await work();
    ctx.holds.succeed(holdKey);
    ctx.deps.tick(holdKey);
    return true;
  } catch (e) {
    await failItem(ctx, holdKey, e, version, page);
    return false;
  }
}

/** Run a pure render; a throw is an item failure (version unknown), never a sweep failure. */
async function safeRender<T>(ctx: AppleSweepCtx, holdKey: string, render: () => T): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: render() };
  } catch (e) {
    if (!ctx.holds.shouldAttempt(holdKey, null)) return { ok: false };
    await failItem(ctx, holdKey, e, null, null);
    return { ok: false };
  }
}

// ── Full reconcile ───────────────────────────────────────────────────────────

/**
 * Removes `gone` pages (already restricted to the sweep's window by the
 * caller). Returns whether the removal ran; a refusal aborts the whole
 * cleanup and marks the run partial.
 */
async function reconcileRemovals(ctx: AppleSweepCtx, service: string, gone: Array<{ key: string; path: string }>, listedCount: number): Promise<boolean> {
  if (gone.length === 0) return true;
  // An empty listing with pages still owned reads as "everything was deleted", which is also what a
  // reader that silently saw nothing looks like. Refuse unless the operator opts in.
  if (listedCount === 0 && !massReconcileAllowed()) {
    ctx.deps.log(`[apple] empty-listing guard refused ${gone.length} ${service} deletes for source ${ctx.deps.sourceId}: the reader listed nothing (set GBRAIN_ALLOW_MASS_RECONCILE=1 if that is really so)`);
    ctx.summary.status = 'partial';
    ctx.summary.incomplete.push(`${service}:empty_listing_refused`);
    return false;
  }
  if (gone.length > APPLE_MASS_RECONCILE_LIMIT && !massReconcileAllowed()) {
    ctx.deps.log(`[apple] mass-delete guard refused ${gone.length} ${service} deletes for source ${ctx.deps.sourceId} (set GBRAIN_ALLOW_MASS_RECONCILE=1 to allow)`);
    ctx.summary.status = 'partial';
    ctx.summary.incomplete.push(`${service}:mass_delete_refused`);
    return false;
  }
  for (const g of gone) await deletePageByRelPath(ctx.deps, g.path, ctx.summary);
  return true;
}

const signalOf = (ctx: AppleSweepCtx): { signal?: AbortSignal } => (ctx.deps.opts.signal ? { signal: ctx.deps.opts.signal } : {});
const aborted = (ctx: AppleSweepCtx): boolean => ctx.deps.opts.signal?.aborted === true;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// ── Calendar ─────────────────────────────────────────────────────────────────

export async function sweepCalendar(ctx: AppleSweepCtx): Promise<void> {
  const { deps, state, summary } = ctx;
  const nowMs = deps.now();
  const from = new Date(nowMs - deps.cfg.historyDays * DAY_MS);
  const to = new Date(nowMs + deps.cfg.futureDays * DAY_MS);
  // A reader error propagates: source-level, nothing is committed or held.
  const listed = await deps.readers.calendar({ from, to, calendarIds: deps.cfg.calendarIds, ...signalOf(ctx) });
  summary.itemsSeen.calendar = listed.length;

  const events = new Map<string, AppleCalendarEvent>();
  for (const ev of listed) events.set(calendarItemKey(ev), ev);

  const pathByKey = new Map<string, string>();
  const startByKey = new Map<string, string>();
  for (const o of await loadOwnedPages(deps, 'apple_event_id')) {
    const id = str(o.frontmatter.apple_event_id);
    const cal = str(o.frontmatter.apple_calendar_id);
    if (id === null || cal === null) continue;
    const key = `${cal}:${id}`;
    pathByKey.set(key, o.sourcePath);
    startByKey.set(key, str(o.frontmatter.start) ?? '');
  }

  const live = new Set<string>();
  for (const key of [...events.keys()].sort()) {
    if (aborted(ctx)) return;
    const ev = events.get(key)!;
    const holdKey = `calendar:${key}`;
    const rendered = await safeRender(ctx, holdKey, () => renderCalendarEventPage(ev, deps.cfg.account));
    if (!rendered.ok) { live.add(key); continue; }
    const page = rendered.value;
    // Cancelled: not rendered, not live; an incremental sweep leaves any existing page alone.
    if (!page) continue;
    live.add(key);
    const hash = renderedHash(page.relPath, page.markdown);
    const existing = pathByKey.get(key);
    if (state.calendar.hashes[key] === hash && existing === page.relPath) continue;
    await attemptItem(ctx, holdKey, hash, page, async () => {
      await importRendered(deps, page.relPath, page.markdown, ctx.activePack, summary, ctx.countedSlugs,
        { apple_event_id: ev.id, apple_calendar_id: ev.calendarId });
      // Staged rename (the event moved to another day or title): the new page lands first.
      if (existing && existing !== page.relPath) await deletePageByRelPath(deps, existing, summary);
      state.calendar.hashes[key] = hash;
      pathByKey.set(key, page.relPath);
      startByKey.set(key, ev.start);
    });
  }
  if (aborted(ctx)) return;

  if (deps.opts.full) {
    const gone: Array<{ key: string; path: string }> = [];
    for (const [key, path] of pathByKey) {
      if (live.has(key)) continue;
      const start = Date.parse(startByKey.get(key) ?? '');
      // Only events starting inside the listed window can be judged gone.
      if (Number.isFinite(start) && start >= from.getTime() && start < to.getTime()) gone.push({ key, path });
    }
    if (await reconcileRemovals(ctx, 'calendar', gone, listed.length)) {
      for (const g of gone) delete state.calendar.hashes[g.key];
      for (const key of Object.keys(state.calendar.hashes)) {
        if (!live.has(key) && !pathByKey.has(key)) delete state.calendar.hashes[key];
      }
    }
  }
  state.calendar.window = { from: from.toISOString(), to: to.toISOString() };
}

// ── Contacts ─────────────────────────────────────────────────────────────────

export async function sweepContacts(ctx: AppleSweepCtx): Promise<void> {
  const { deps, state, summary } = ctx;
  const dir = deps.cfg.contactsDir;
  const listed = await deps.readers.contacts({ ...signalOf(ctx) });
  summary.itemsSeen.contacts = listed.length;

  const contacts = new Map<string, AppleContact>();
  for (const c of listed) contacts.set(c.id, c);

  const pathById = new Map<string, string>();
  const ownerByPath = new Map<string, string>();
  for (const o of await loadOwnedPages(deps, 'apple_contact_id')) {
    const id = str(o.frontmatter.apple_contact_id);
    if (id === null) continue;
    pathById.set(id, o.sourcePath);
    ownerByPath.set(o.sourcePath, id);
  }
  const livePaths = await loadLivePaths(deps, `${dir}/`);

  const live = new Set<string>();
  // Sorted so a name collision resolves the same way on every run.
  for (const c of [...contacts.values()].sort(byId((x) => x.id))) {
    if (aborted(ctx)) return;
    const holdKey = `contacts:${c.id}`;
    const rendered = await safeRender(ctx, holdKey, () => {
      const baseSlug = personSlugFromContact(c, false, dir);
      if (!baseSlug) return null;
      const baseOwner = ownerByPath.get(`${baseSlug}.md`);
      return renderPersonPage(c, baseOwner !== undefined && baseOwner !== c.id, dir);
    });
    if (!rendered.ok) { live.add(c.id); continue; }
    const page = rendered.value;
    if (!page) continue;
    live.add(c.id);
    const owner = ownerByPath.get(page.relPath);
    if (owner === undefined && livePaths.has(page.relPath)) {
      // Hand-authored (or another connector's) page: body and frontmatter untouched.
      deps.log(`[apple] skipping hand-authored ${page.relPath}`);
      continue;
    }
    if (owner !== undefined && owner !== c.id) {
      deps.log(`[apple] skipping ${page.relPath}: owned by another contact`);
      continue;
    }
    const hash = renderedHash(page.relPath, page.markdown);
    const existing = pathById.get(c.id);
    if (state.contacts.hashes[c.id] === hash && existing === page.relPath) continue;
    await attemptItem(ctx, holdKey, hash, page, async () => {
      await importRendered(deps, page.relPath, page.markdown, ctx.activePack, summary, ctx.countedSlugs, { apple_contact_id: c.id });
      // Staged rename (renamed contact or changed contacts dir): retire the old page once the new one exists.
      if (existing && existing !== page.relPath && ownerByPath.get(existing) === c.id) {
        await deletePageByRelPath(deps, existing, summary);
        ownerByPath.delete(existing);
      }
      ownerByPath.set(page.relPath, c.id);
      pathById.set(c.id, page.relPath);
      state.contacts.hashes[c.id] = hash;
    });
  }
  if (aborted(ctx)) return;

  if (deps.opts.full) {
    const gone: Array<{ key: string; path: string }> = [];
    for (const [id, path] of pathById) if (!live.has(id)) gone.push({ key: id, path });
    if (await reconcileRemovals(ctx, 'contacts', gone, listed.length)) {
      for (const g of gone) delete state.contacts.hashes[g.key];
      for (const id of Object.keys(state.contacts.hashes)) {
        if (!live.has(id) && !pathById.has(id)) delete state.contacts.hashes[id];
      }
    }
  }
}

// ── Mail ─────────────────────────────────────────────────────────────────────

/** Re-read this much before the newest message of the last complete run (late-arriving / re-dated mail). */
export const APPLE_MAIL_OVERLAP_MS = 2 * DAY_MS;

/**
 * Where this run starts reading. `--full` always reads the whole configured window (its removals are
 * judged against that listing); an incremental run reads from a 2-day overlap before the newest
 * message it has seen, or from where a capped run stopped, never earlier than the window.
 */
export function mailReadSince(state: AppleSourceState, windowStart: Date, full: boolean): Date {
  if (full) return windowStart;
  const resume = Date.parse(state.mail.resume_from ?? '');
  const newest = Date.parse(state.mail.newest ?? '');
  const from = Number.isFinite(resume) ? resume - 1 : Number.isFinite(newest) ? newest - APPLE_MAIL_OVERLAP_MS : windowStart.getTime();
  return new Date(Math.max(windowStart.getTime(), from));
}

export async function sweepMail(ctx: AppleSweepCtx): Promise<void> {
  const { deps, state, summary } = ctx;
  const windowStart = new Date(deps.now() - deps.cfg.mailDays * DAY_MS);
  // Loop tracking must see the whole window once when the owner set changed or extraction was just consented.
  const trackLoops = ctx.loops !== undefined && appleLoopsAvailability(deps.cfg).available;
  const rereadAll = trackLoops && prepareLoopsState(state, deps.cfg) && state.mail.resume_from === undefined;
  const since = mailReadSince(state, windowStart, deps.opts.full === true || rereadAll);
  const failedBefore = summary.failedFiles;
  const read = await deps.readers.mail({ since, mailboxes: deps.cfg.mailMailboxes, max: deps.cfg.mailMax,
    ...(state.mail.resume_from && state.mail.resume_id ? { after: { date: state.mail.resume_from, id: state.mail.resume_id } } : {}), ...signalOf(ctx) });
  const listing: AppleMailListing = Array.isArray(read) ? { messages: read } : read;
  const messages = listing.messages;
  const truncated = listing.truncated === true;
  const readable = listing.incomplete !== true;
  summary.itemsSeen.mail = messages.length;
  if (truncated) {
    summary.status = 'partial';
    summary.incomplete.push('mail:truncated');
    deps.log(`[apple] mail listing truncated at ${deps.cfg.mailMax} messages (a_mail_max); the rest is read on the next run`);
  }
  if ((listing.unavailableThreads?.length ?? 0) > 0) {
    summary.status = 'partial';
    summary.incomplete.push('mail:unavailable_threads');
    deps.log(`[apple] ${listing.unavailableThreads!.length} mail thread(s) contain unreadable messages; the cursor will not advance`);
  }
  if (!readable) {
    summary.status = 'partial';
    summary.incomplete.push('mail:unreadable_messages');
    deps.log('[apple] some mail messages could not be read; nothing is removed this run');
  }

  const pathByThread = new Map<string, string>();
  const frontmatterByThread = new Map<string, Record<string, unknown>>();
  for (const o of await loadOwnedPages(deps, 'apple_thread_id')) {
    const id = str(o.frontmatter.apple_thread_id);
    if (id === null) continue;
    pathByThread.set(id, o.sourcePath);
    frontmatterByThread.set(id, o.frontmatter);
  }

  // A thread with an unreadable message still exists upstream: it is live for the sweep (never deleted).
  const live = new Set<string>(listing.unavailableThreads ?? []);
  // Open-loop bookkeeping: threads with a page this run, and those whose page did not land (failed render/import, held).
  const rendered = new Set<string>();
  const notLanded = new Set<string>();
  const landedSlug = new Map<string, string>();
  for (const thread of groupMailThreads(messages)) {
    if (aborted(ctx)) return;
    const holdKey = `mail:${thread.threadId}`;
    const first = await safeRender(ctx, holdKey, () => renderMailThreadPage(thread, deps.cfg.account));
    if (!first.ok) { live.add(thread.threadId); notLanded.add(thread.threadId); continue; }
    let page = first.value;
    if (!page) continue; // automated mail renders nothing
    live.add(thread.threadId);
    rendered.add(thread.threadId);
    const existing = pathByThread.get(thread.threadId);
    if (state.mail.hashes[thread.threadId] === renderedHash(page.relPath, page.markdown) && existing === page.relPath) continue;
    if (existing) {
      // The read window no longer lists the oldest messages of a long thread: carry them forward from the page.
      const stored = frontmatterByThread.get(thread.threadId) ?? {};
      let prior;
      try { prior = await loadMailPrior(ctx, existing, stored); } catch (e) {
        if (ctx.holds.shouldAttempt(holdKey, null)) await failItem(ctx, holdKey, e, null, null);
        notLanded.add(thread.threadId);
        continue;
      }
      if (prior) {
        const carried = await safeRender(ctx, holdKey, () => renderMailThreadPage(thread, deps.cfg.account, prior));
        if (!carried.ok) { notLanded.add(thread.threadId); continue; }
        if (carried.value) page = carried.value;
      } else {
        // The stored page names messages this listing no longer returns and its body cannot be split back
        // into per-message blocks: rewriting it from the listing would silently drop them. Keep the page.
        const listed = new Set(thread.messages.map((m) => m.id));
        const storedIds = Array.isArray(stored.apple_message_ids) ? stored.apple_message_ids.filter((x): x is string => typeof x === 'string') : [];
        const dropped = storedIds.filter((id) => !listed.has(id));
        if (dropped.length > 0) {
          if (ctx.holds.shouldAttempt(holdKey, null)) {
            await failItem(ctx, holdKey, new Error(`stored mail page ${existing} holds ${dropped.length} message(s) the reader no longer lists and cannot be carried forward; page left unchanged`), null, null);
          }
          notLanded.add(thread.threadId);
          continue;
        }
      }
    }
    const final = page;
    const hash = renderedHash(final.relPath, final.markdown);
    if (state.mail.hashes[thread.threadId] === hash && existing === final.relPath) continue;
    const landed = await attemptItem(ctx, holdKey, hash, final, async () => {
      const slug = await importRendered(deps, final.relPath, final.markdown, ctx.activePack, summary, ctx.countedSlugs,
        { apple_thread_id: thread.threadId, apple_message_ids: thread.messages.map((m) => m.id) });
      landedSlug.set(thread.threadId, slug);
      if (existing && existing !== final.relPath) await deletePageByRelPath(deps, existing, summary);
      state.mail.hashes[thread.threadId] = hash;
      pathByThread.set(thread.threadId, final.relPath);
    });
    if (!landed) notLanded.add(thread.threadId);
  }
  if (aborted(ctx)) return;

  if (trackLoops && ctx.loops) {
    const slugByThread = new Map(landedSlug);
    const missing = [...rendered].filter((id) => !slugByThread.has(id) && !notLanded.has(id));
    if (missing.length > 0) {
      const rows = await deps.engine.executeRaw<{ slug: string; tid: string }>(
        `SELECT slug, frontmatter->>'apple_thread_id' AS tid FROM pages
          WHERE source_id = $1 AND deleted_at IS NULL AND frontmatter->>'apple_thread_id' = ANY(string_to_array($2, E'\\n'))`,
        [deps.sourceId, missing.join('\n')]);
      for (const r of rows) slugByThread.set(r.tid, r.slug);
    }
    // A rendered thread whose page is not in the brain (pending managed write) cannot carry a loop yet.
    for (const id of rendered) if (!slugByThread.has(id)) notLanded.add(id);
    await trackMailLoops({
      engine: deps.engine, sourceId: deps.sourceId, cfg: deps.cfg, state, log: deps.log, now: deps.now, ...signalOf(ctx),
      run: ctx.loops, messages, slugByThread, notLanded, unavailableThreads: new Set(listing.unavailableThreads ?? []),
      listingClean: !truncated && readable && summary.failedFiles === failedBefore,
    });
  }

  // The removal verdict needs a complete listing of the whole window: an incremental read, a capped read
  // and an unreadable-message read are all partial views.
  if (deps.opts.full === true && !truncated && readable) {
    const gone: Array<{ key: string; path: string }> = [];
    for (const [tid, path] of pathByThread) {
      if (live.has(tid)) continue;
      const firstDate = Date.parse(str(frontmatterByThread.get(tid)?.first_message_date) ?? '');
      // Threads that began before the mail window are out of enumeration scope.
      if (Number.isFinite(firstDate) && firstDate >= windowStart.getTime()) gone.push({ key: tid, path });
    }
    if (await reconcileRemovals(ctx, 'mail', gone, messages.length)) {
      for (const g of gone) delete state.mail.hashes[g.key];
      for (const tid of Object.keys(state.mail.hashes)) {
        if (!live.has(tid) && !pathByThread.has(tid)) delete state.mail.hashes[tid];
      }
    }
  }

  state.mail.since = windowStart.toISOString();
  const newestMs = messages.reduce((m, x) => Math.max(m, Date.parse(x.date) || 0), 0);
  const unresolved = !readable || (listing.unavailableThreads?.length ?? 0) > 0 || summary.failedFiles !== failedBefore;
  if (!unresolved && truncated && messages.length > 0) {
    // Advance by a stable (date,id) key, not timestamp alone: Mail.app can have
    // hundreds of messages at one timestamp and its native filter is date-only.
    const boundary = messages[messages.length - 1]!;
    state.mail.resume_from = boundary.date;
    state.mail.resume_id = boundary.id;
  } else if (!unresolved && !truncated) {
    delete state.mail.resume_from;
    delete state.mail.resume_id;
    if (newestMs > 0) state.mail.newest = new Date(Math.max(newestMs, Date.parse(state.mail.newest ?? '') || 0)).toISOString();
  }
  // On any failed import or coverage gap, keep the previous boundary so the
  // next run repeats the unresolved slice rather than skipping past it.
}

/**
 * The prior mail page, for carrying forward messages the reader window no
 * longer lists. A mail thread page is inline by construction (bounded message
 * bodies); a segmented one is refused with `page_body_segmented` rather than
 * rewritten without its older messages.
 */
async function loadMailPrior(ctx: AppleSweepCtx, relPath: string, frontmatter: Record<string, unknown>) {
  const rows = await ctx.deps.engine.executeRaw<{ compiled_truth: string | null; title: string | null; body_storage: string | null; slug: string }>(
    `SELECT compiled_truth, title, body_storage, slug FROM pages WHERE source_id = $1 AND source_path = $2 AND deleted_at IS NULL LIMIT 1`,
    [ctx.deps.sourceId, relPath],
  );
  const row = rows[0];
  if (row) assertInlineBody({ body_storage: row.body_storage as 'inline' | 'segmented' | null, slug: row.slug, source_id: ctx.deps.sourceId }, 'apple mail carry-forward');
  const body = row?.compiled_truth;
  return typeof body === 'string' ? mailPriorFromPage(relPath, frontmatter, body, row?.title ?? null) : null;
}

export { contactDisplayName };
