/** Contacts reader: Contacts.framework via scripts/apple/contacts.swift (read-only). */
import { fileURLToPath } from 'node:url';
import type { AppleContact } from '../types.ts';
import { readerError } from './errors.ts';
import { runHelper } from './run-helper.ts';
import { str, strArray, SWIFT_BIN, type HelperOverrides } from './calendar.ts';

export const CONTACTS_SCRIPT = fileURLToPath(new URL('../../../../scripts/apple/contacts.swift', import.meta.url));

export function normalizeContact(raw: unknown): AppleContact {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const id = str(o.id);
  if (!id) throw readerError('malformed_output', 'contacts', 'contact item missing id');
  const c: AppleContact = { id, emails: strArray(o.emails), phones: strArray(o.phones), groups: strArray(o.groups) };
  const givenName = str(o.givenName); if (givenName) c.givenName = givenName;
  const familyName = str(o.familyName); if (familyName) c.familyName = familyName;
  const nickname = str(o.nickname); if (nickname) c.nickname = nickname;
  const organization = str(o.organization); if (organization) c.organization = organization;
  const jobTitle = str(o.jobTitle); if (jobTitle) c.jobTitle = jobTitle;
  const lastModified = str(o.lastModified); if (lastModified) c.lastModified = lastModified;
  return c;
}

export async function readContacts(opts: { signal?: AbortSignal }, o: HelperOverrides = {}): Promise<AppleContact[]> {
  const items = await runHelper({ service: 'contacts', command: o.command ?? SWIFT_BIN, args: o.scriptArgs ?? [CONTACTS_SCRIPT, '--'], signal: opts.signal, timeoutMs: o.timeoutMs, maxStdoutBytes: o.maxStdoutBytes, platform: o.platform, env: o.env });
  return items.map(normalizeContact);
}

export async function probeContacts(o: HelperOverrides = {}): Promise<void> {
  await runHelper({ service: 'contacts', command: o.command ?? SWIFT_BIN, args: [...(o.scriptArgs ?? [CONTACTS_SCRIPT, '--']), '--probe'], timeoutMs: o.timeoutMs ?? 60_000, platform: o.platform, env: o.env });
}
