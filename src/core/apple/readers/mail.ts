/** Mail reader: Mail.app public scripting dictionary via scripts/apple/mail.js (JXA, read-only). */
import { fileURLToPath } from 'node:url';
import type { AppleMailListing } from '../types.ts';
import type { AppleMailMessage } from '../types.ts';
import { readerError } from './errors.ts';
import { runHelperDocument } from './run-helper.ts';
import { str, strArray, withScriptArgs, type HelperOverrides } from './calendar.ts';

/** Source-tree path of the helper (tests / `osacompile`). Runtime uses the embedded text. */
export const MAIL_SCRIPT = fileURLToPath(new URL('../../../../scripts/apple/mail.js', import.meta.url));
export const OSASCRIPT_BIN = '/usr/bin/osascript';
export const MAIL_BODY_CAP = 20000;
/**
 * Wall-clock budget the helper gets for reading message bodies. Mail.app can take ~20 s to produce
 * `content` for one HTML newsletter (live-Mac observation), so the helper stops starting new body
 * batches after this and returns what it has as `truncated` + `budgetExhausted`; the sweep resumes
 * from the last message next run. Counted from helper start; with 3-message batches the worst case
 * (45 s + 3 × 20 s) stays under DEFAULT_HELPER_TIMEOUT_MS (120 s).
 */
export const MAIL_BODY_BUDGET_MS = 45_000;

export function normalizeMessage(raw: unknown): AppleMailMessage {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = str(o.id);
  const date = str(o.date);
  if (!id || !date) throw readerError('malformed_output', 'mail', 'mail item missing id/date');
  const body = typeof o.body === 'string' ? o.body.slice(0, MAIL_BODY_CAP) : '';
  return {
    id,
    threadId: str(o.threadId) ?? id,
    mailbox: str(o.mailbox) ?? '',
    subject: typeof o.subject === 'string' ? o.subject : '',
    from: typeof o.from === 'string' ? o.from : '',
    to: strArray(o.to),
    cc: strArray(o.cc),
    date,
    body,
    read: o.read === true,
    // Header verdicts for open-loop tracking: present only when the helper reported them (absent = unclassified).
    ...(typeof o.automated === 'boolean' ? { automated: o.automated } : {}),
    ...(typeof o.bulk === 'boolean' ? { bulk: o.bulk } : {}),
  };
}

const OSASCRIPT_PREFIX = ['-l', 'JavaScript'];

export async function readMail(
  opts: { since: Date; mailboxes: string[]; max?: number; after?: { date: string; id: string }; signal?: AbortSignal },
  o: HelperOverrides = {},
): Promise<AppleMailListing> {
  const { items, doc } = await withScriptArgs('mail.js', o, OSASCRIPT_PREFIX, async (scriptArgs) => {
    const args = [...scriptArgs, '--since', opts.since.toISOString(), '--mailboxes', opts.mailboxes.join(',')];
    if (opts.max !== undefined) args.push('--max', String(opts.max));
    if (opts.after) args.push('--after-date', opts.after.date, '--after-id', opts.after.id);
    args.push('--budget-ms', String(MAIL_BODY_BUDGET_MS));
    return runHelperDocument({ service: 'mail', command: o.command ?? OSASCRIPT_BIN, args, signal: opts.signal, timeoutMs: o.timeoutMs, maxStdoutBytes: o.maxStdoutBytes, platform: o.platform, env: o.env });
  });
  return {
    messages: items.map(normalizeMessage),
    truncated: doc.truncated === true,
    budgetExhausted: doc.budget_exhausted === true,
    unavailableThreads: strArray(doc.unavailable),
    incomplete: doc.incomplete === true,
  };
}

export async function probeMail(o: HelperOverrides = {}): Promise<void> {
  await withScriptArgs('mail.js', o, OSASCRIPT_PREFIX, (scriptArgs) =>
    runHelperDocument({ service: 'mail', command: o.command ?? OSASCRIPT_BIN, args: [...scriptArgs, '--probe'], timeoutMs: o.timeoutMs ?? 60_000, platform: o.platform, env: o.env }));
}
