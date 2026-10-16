/** Default Apple readers (macOS only). Every entry point gates on darwin. */
import type { AppleReaders, AppleService } from '../types.ts';
import { AppleReaderError, readerError } from './errors.ts';
import { assertDarwin } from './run-helper.ts';
import { readCalendar, probeCalendar, type HelperOverrides } from './calendar.ts';
import { readContacts, probeContacts } from './contacts.ts';
import { readMail, probeMail } from './mail.ts';

export { AppleReaderError, fixFor, readerError } from './errors.ts';
export type { AppleReaderErrorCode } from './errors.ts';
export { runHelper } from './run-helper.ts';

export function createAppleReaders(overrides: HelperOverrides = {}): AppleReaders {
  return {
    async calendar(opts) {
      assertDarwin('calendar', overrides.platform);
      return readCalendar(opts, overrides);
    },
    async contacts(opts) {
      assertDarwin('contacts', overrides.platform);
      return readContacts(opts, overrides);
    },
    async mail(opts) {
      assertDarwin('mail', overrides.platform);
      return readMail(opts, overrides);
    },
    async probe(service: AppleService) {
      try {
        assertDarwin(service, overrides.platform);
        if (service === 'calendar') await probeCalendar(overrides);
        else if (service === 'contacts') await probeContacts(overrides);
        else await probeMail(overrides);
        return { ok: true as const };
      } catch (e) {
        if (e instanceof AppleReaderError) return { ok: false as const, code: e.code, fix: e.fix };
        const err = readerError('helper_failed', service, e instanceof Error ? e.message : String(e));
        return { ok: false as const, code: err.code, fix: err.fix };
      }
    },
  };
}
