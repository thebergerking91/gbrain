/**
 * Apple reader errors (issue #6855). `types.ts` re-exports these; this file
 * must not import runtime values from `../types.ts` (cycle).
 */
export type AppleReaderService = 'calendar' | 'contacts' | 'mail';

export type AppleReaderErrorCode =
  | 'unsupported_platform'
  | 'permission_denied'
  | 'helper_failed'
  | 'helper_timeout'
  | 'malformed_output'
  | 'automation_denied'
  | 'mail_not_running_or_unconfigured';

export const APPLE_READER_ERROR_CODES: readonly AppleReaderErrorCode[] = [
  'unsupported_platform',
  'permission_denied',
  'helper_failed',
  'helper_timeout',
  'malformed_output',
  'automation_denied',
  'mail_not_running_or_unconfigured',
];

export class AppleReaderError extends Error {
  code: AppleReaderErrorCode;
  fix: string;
  service: AppleReaderService;

  constructor(code: AppleReaderErrorCode, service: AppleReaderService, message: string, fix: string) {
    super(message);
    this.name = 'AppleReaderError';
    this.code = code;
    this.service = service;
    this.fix = fix;
  }
}

export function isAppleReaderErrorCode(v: unknown): v is AppleReaderErrorCode {
  return typeof v === 'string' && (APPLE_READER_ERROR_CODES as readonly string[]).includes(v);
}

const SERVICE_LABEL: Record<AppleReaderService, string> = {
  calendar: 'Calendar',
  contacts: 'Contacts',
  mail: 'Mail',
};

/**
 * Actionable next step for each code. These are guidance strings based on
 * documented macOS behavior; they were not verified against a live TCC prompt.
 * Privacy panes live under System Settings > Privacy & Security.
 */
export function fixFor(code: AppleReaderErrorCode, service: AppleReaderService): string {
  switch (code) {
    case 'unsupported_platform':
      return 'The Apple connector reads Calendar, Contacts and Mail through macOS frameworks and only runs on macOS. Run this source on a Mac, or remove the apple source on this host.';
    case 'permission_denied': {
      if (service === 'mail') {
        return 'Grant access in System Settings > Privacy & Security > Automation (see automation_denied for Mail).';
      }
      const pane = service === 'calendar' ? 'Calendars (or Full Calendar Access)' : 'Contacts';
      return `Open System Settings > Privacy & Security > ${pane} and enable the app that runs gbrain (Terminal, iTerm, or the launcher/daemon host app), then retry. If the app is not listed, run the sync once from that app in an interactive session so macOS can prompt. If you previously denied it, reset with: tccutil reset ${service === 'calendar' ? 'Calendar' : 'AddressBook'} (all apps).`;
    }
    case 'automation_denied':
      return 'Open System Settings > Privacy & Security > Automation, find the app that runs gbrain (Terminal, iTerm, or the launcher/daemon host app) and enable its "Mail" switch, then retry. If it is not listed, run the sync once from that app in an interactive session so macOS can prompt.';
    case 'mail_not_running_or_unconfigured':
      return 'Open Mail.app, add at least one account, and let it finish loading; the helper does not launch Mail itself. Then retry.';
    case 'helper_timeout':
      return `The ${SERVICE_LABEL[service]} helper did not finish in time. Retry; for large data sets reduce the window (history/future days, mail days) or mailboxes, and check that no macOS permission dialog is waiting for an answer.`;
    case 'malformed_output':
      return `The ${SERVICE_LABEL[service]} helper returned output gbrain could not parse. Retry once; if it persists, run the helper by hand and report the (redacted) output.`;
    case 'helper_failed':
      return `The ${SERVICE_LABEL[service]} helper failed. Check the message above; ensure Xcode Command Line Tools are installed (xcode-select --install) for Calendar and Contacts.`;
  }
}

export function readerError(
  code: AppleReaderErrorCode,
  service: AppleReaderService,
  message: string,
): AppleReaderError {
  return new AppleReaderError(code, service, message, fixFor(code, service));
}
