/** Mail reader: Mail.app public scripting dictionary via scripts/apple/mail.js (JXA, read-only). */
import { fileURLToPath } from 'node:url';
import type { AppleMailMessage } from '../types.ts';
import { readerError } from './errors.ts';
import { runHelper } from './run-helper.ts';
import { str, strArray, type HelperOverrides } from './calendar.ts';

export const MAIL_SCRIPT = fileURLToPath(new URL('../../../../scripts/apple/mail.js', import.meta.url));
export const OSASCRIPT_BIN = '/usr/bin/osascript';
export const MAIL_BODY_CAP = 20000;

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
  };
}

const jxaArgs = (o: HelperOverrides): string[] => o.scriptArgs ?? ['-l', 'JavaScript', MAIL_SCRIPT];

export async function readMail(
  opts: { since: Date; mailboxes: string[]; signal?: AbortSignal },
  o: HelperOverrides = {},
): Promise<AppleMailMessage[]> {
  const args = [...jxaArgs(o), '--since', opts.since.toISOString(), '--mailboxes', opts.mailboxes.join(',')];
  const items = await runHelper({ service: 'mail', command: o.command ?? OSASCRIPT_BIN, args, signal: opts.signal, timeoutMs: o.timeoutMs, maxStdoutBytes: o.maxStdoutBytes, platform: o.platform, env: o.env });
  return items.map(normalizeMessage);
}

export async function probeMail(o: HelperOverrides = {}): Promise<void> {
  await runHelper({ service: 'mail', command: o.command ?? OSASCRIPT_BIN, args: [...jxaArgs(o), '--probe'], timeoutMs: o.timeoutMs ?? 60_000, platform: o.platform, env: o.env });
}
