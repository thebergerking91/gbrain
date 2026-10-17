# Connecting Apple (Calendar, Contacts, Mail on macOS)

gbrain's apple connector ingests your Mac's Calendar events, Contacts and Mail
threads into your brain as pages, the same way the [google connector](google-connect.md)
does for Google accounts, but with no cloud account in the middle: it reads the
data already on your Mac.

It is **read-only** toward Apple, holds **no credentials**, and works **only on
macOS 14 (Sonoma) or newer with Xcode Command Line Tools 15 or newer**
(`xcode-select --install`). On an older macOS or toolchain the Calendar and
Contacts helpers fail to compile; gbrain reports that as `macos_too_old` with
the fix instead of a compiler error. Each of the three services is opt-in per
service, and **Mail is never on by default**.

> The helpers have not been run against real Calendar, Contacts or Mail data by
> the people who wrote them: they compile and are tested against fakes. Treat the
> first sync on a real Mac as the first real test, and read the pages it writes.

## The fast path (one command)

```bash
gbrain apple setup
```

`setup` is idempotent (re-running is always safe) and walks the chain:

1. confirms **Mail** with you (it is the most sensitive service; see
   [Mail confirmation](#mail-confirmation)),
2. probes each selected service for the macOS permission it needs. A service
   macOS has **not asked about yet** (`permission_not_determined`, not a denial)
   gets its prompt: when you run setup in a terminal (or pass `--yes`) gbrain
   asks macOS once and re-probes, so click **Allow** when the dialog appears. With
   no terminal attached, setup prints a message that a prompt will appear on the
   Mac's screen and exits 2,
3. if one is denied, prints the exact System Settings pane to fix and stops
   (exit 2) so you can grant it and re-run,
4. registers the source (once), and
5. runs a first sync under a wall-clock budget (`--sync-budget-ms`, default
   90 s); whatever did not fit resumes on every later sync. `--no-sync` skips it.

```bash
gbrain apple setup --services calendar,contacts      # opt Mail out
gbrain apple setup --yes                             # all three, Mail confirmed
gbrain apple status                                  # live per-service probe, last sync, held items
gbrain apple status --no-probe                       # no helper runs; last recorded probe
gbrain apple services                                # which services are enabled
gbrain sources set-services apple-local --remove mail
```

Every subcommand accepts `--json` and emits the same envelope as `gbrain google`:
`{ ok, status, next_action: { command?, user_message? }, error?: { code, problem, cause, fix, doc_url } }`.
Exit codes: **0** done, **1** failed, **2** waiting on you (a permission, or the
Mail confirmation).

The pieces, if you want them separately:

```bash
gbrain sources add apple-local --kind apple --services calendar,contacts
gbrain sync --source apple-local
```

## Choosing services (opt-out)

`--services` takes any subset of `calendar,contacts,mail`. `gbrain apple setup`
without `--services` selects all three and then asks you to confirm Mail;
`gbrain sources add --kind apple` without `--services` enables **calendar and
contacts only**. Including Mail needs `mail` in `--services` **and**
`--confirm-mail` (error `mail_confirmation_required` otherwise).
An unknown or empty value is an error (`unknown_service` / `empty_services`);
it is never widened to "everything", because Mail and Contacts are private data.

Change them later with `gbrain sources set-services <source> --add|--remove <service>`
(`--add mail` also needs `--confirm-mail`).
**Removing a service never deletes pages**: the ones already imported stay, they
are simply no longer updated. A disabled service is not read at all (its helper
never runs and its permission is never requested). On a managed brain the
change starts a fresh sync cursor for the source and asks for `--yes` first.

## Source options

| Flag | Default | Meaning |
|---|---|---|
| `--services` | `calendar,contacts` (`sources add`); all three after confirmation (`apple setup`) | which services to sync |
| `--confirm-mail` | off | consent to read Mail; required when `mail` is in `--services` |
| `--account <label>` | `local` | a free label for this Mac's account; **not a credential** |
| `--history-days <n>` | 90 (max 3650) | calendar events this far back |
| `--future-days <n>` | 60 (max 3650) | calendar events this far ahead |
| `--calendar-ids <a,b>` | all calendars | only these calendars |
| `--contacts-dir <dir>` | `people` | where contact pages go (relative, lower-case segments) |
| `--mail-mailboxes <a,b>` | `INBOX,Sent` | which mailboxes |
| `--mail-days <n>` | 30 (max 365) | mail this far back |
| `--mail-owner-addresses <a,b>` | none | your own addresses; **required** for unanswered-mail tracking (see [Open loops](#open-loops-unanswered-mail)) |
| `--consent-loops-extraction` | off | consent to send Mail thread text to the chat provider for commitment/decision extraction |
| `a_mail_max` (config key) | 500 (max 5000) | messages read per run; a larger backlog is read over several runs |
| `--dir <path>` | `~/.gbrain/clones/<id>-apple` | the managed directory |

Registering on a non-macOS host prints a warning but works (so a CI or
sync-only host can hold the registration); a sync there reports
`unsupported_platform`.

## Permissions

macOS asks the **app that runs gbrain** (Terminal, iTerm, or whatever launches
the daemon/autopilot) for each service separately. gbrain cannot grant them; it
only probes and tells you where to go. The panes below follow documented macOS
behavior and have not been verified against a live prompt on every macOS version.

| Service | Where | What to enable |
|---|---|---|
| Calendar | System Settings > Privacy & Security > **Calendars** (or Full Calendar Access) | the app that runs gbrain |
| Contacts | System Settings > Privacy & Security > **Contacts** | the app that runs gbrain |
| Mail | System Settings > Privacy & Security > **Automation** | the "Mail" switch under the app that runs gbrain |

If the app is not listed, run the command once from that app in an interactive
session so macOS can prompt. **Unattended runs (autopilot, a daemon, cron) cannot
show those prompts**: grant each service by running `gbrain apple setup` or
`gbrain sync --source <id>` once from a terminal on the Mac, then unattended
syncs work. A denial recorded by a sync is stored with the source's state, so
`gbrain doctor` (`apple_permissions`) and `gbrain apple status --no-probe` show it. If you previously denied it, `tccutil reset
Calendar` / `tccutil reset AddressBook` (all apps) clears the decision; for Mail,
remove the app from the Automation list and retry. Mail also needs Mail.app to
be **running** with at least one account configured and finished loading; gbrain
never launches Mail itself, on a probe or on a sync (it checks `running()` first
and reports `mail_not_running_or_unconfigured`).

`gbrain doctor` has an `apple_permissions` check: zero helper runs, it reads the
last probe each sync recorded and warns when an enabled service was denied.

### Mail confirmation

Because Mail is the most sensitive service, `setup` refuses to touch it without
an explicit `--confirm-mail` (or `--yes`) and exits 2 with `awaiting_confirmation`
and the exact command to run. The confirmation message states what is read
(subject, sender, recipients, date and plain-text body of recent messages from the
configured mailboxes), and that attachments are never downloaded. Opting Mail out
(`--services calendar,contacts`) needs no confirmation.

## What the pages look like

- **Calendar** (`type: meeting`): `calendar/YYYY/MM/YYYY-MM-DD-<title>-<id8>.md`
  with start/end, location, attendees and notes. Cancelled events render nothing.
- **Contacts** (`type: person`): `<contacts-dir>/<name>.md` with emails, phones
  and groups. A contact with no name, email or phone renders nothing.
- **Mail** (`type: email`): one page per thread, `emails/YYYY/MM/YYYY-MM-DD-<subject>-<id8>.md`,
  messages in date order, bodies inside a fenced quote (they are untrusted data
  and are never interpreted). Pure automated mail (every message from a
  no-reply/notification sender) renders nothing, as in the google connector.

An incremental sync never deletes: a vanished event, contact or thread keeps its
page. `gbrain sync --source <id> --full` reconciles upstream deletions. It
refuses (the run is `partial`, nothing is deleted) when the reader's listing is
empty but pages exist for that service, when more than 200 removals are due, or
when the listing is known to be short (a mail run cut off at `a_mail_max`, a
message Mail could not read), unless `GBRAIN_ALLOW_MASS_RECONCILE=1` for the
first two. A configured calendar id or mailbox that matches nothing is an error
(`selection_not_found`), not an empty listing. An identical re-run adds and
modifies nothing.

Mail reads are incremental: after the first run only messages since two days
before the newest one already seen are read (`--full` re-reads the whole
`--mail-days` window), capped per run by `a_mail_max`.

Calendar notes: birthday calendars are skipped, and subscription calendars
(holidays, sports) are read only when selected with `--calendar-ids`. A recurring
event's pages are keyed on its series id plus the occurrence start, so
**rescheduling a series creates new occurrence pages**; the old ones stay until
`gbrain sync --source <id> --full` removes them. Multi-day timed events show the
end date as well as the time.

## Open loops (unanswered mail)

`gbrain waiting` / `open_loops` reuse the Google open-loop engine on Mail threads: "I owe a reply"
(inbound, unanswered after 24 h) and "I'm waiting on them" (your question, unanswered after 72 h), closed
automatically when the turn flips, with the same grace windows, mutes and noise rules.

```bash
gbrain apple setup --services calendar,contacts,mail --confirm-mail --mail-owner-addresses me@example.com,me-alias@example.com
gbrain apple loops --source apple-local --mail-owner-addresses me@example.com   # on an existing source (reads no Apple data)
```

- **Identity is explicit.** Direction comes only from `--mail-owner-addresses` (config `a_mail_owner_addresses`).
  The `--account` label is free text and the Sent mailbox is never read as identity (aliases, shared mailboxes).
  Without owner addresses Mail still imports, but loop tracking is **unavailable (`identity_missing`)**, and
  `gbrain waiting` says so instead of "You are clean".
- **No model call for tracking.** Unanswered-mail detection is deterministic and needs no consent.
- **Extraction is a separate, second consent.** Commitment/decision extraction sends the text of Mail threads
  (sender, recipients, subject, plain-text body) to the chat provider configured for this brain, one call per
  eligible thread, within the daily `loops.extraction_max_usd_per_day` cap. It runs only when **both**
  `loops.extraction_enabled` (global, default on) **and** this source's `--consent-loops-extraction` (default
  off, needs owner addresses) are set; the job handler re-checks both when it runs. Withdraw with
  `gbrain apple loops --revoke-loops-extraction`. Turning it on re-reads the mail window once.
- **Freshness.** `waiting` treats an Apple source as fresh only after a Mail sweep that was complete and
  detected loops in that same run. A Contacts or Calendar sync, a truncated or partly unreadable Mail run,
  a held or unimported thread, or a message the helper could not classify keeps the answer stale (`waiting`
  refuses unless `--stale-ok`). Changing the owner addresses makes the old freshness stale until a clean re-read.
- **No Gmail labels.** Mail has none, so none are invented. Machine mail (`Auto-Submitted`, `text/calendar`)
  and bulk mail (`List-Unsubscribe`, `List-Id`, `Precedence: bulk|list|junk`, no-reply `Reply-To`) are recognised
  from headers the helper reports; the Gmail category rule and `loops.extraction_exclude_labels` have no Apple
  equivalent. If that exclusion is configured, paid extraction for Apple sources is **withheld**
  (`excluded_label_unsupported`) rather than ignored; tracking is unaffected. `loops mute` works on Apple sources.
- **Bounded state.** The detector keeps the last 12 short messages of up to 100 recent threads in the source's
  cursor state (a 120-character excerpt each), so a grace-held loop can open later without re-reading Mail.

## Privacy and custody

- **Read-only.** The connector reads Calendar through EventKit, Contacts through
  the Contacts framework and Mail through Mail.app's scripting dictionary. It
  writes nothing to any of them.
- **No credentials.** There is no token, password or API key; macOS grants
  access per app. `--account` is only a label.
- **Local files.** Pages and the cursor state (`.apple-source.json`) live in the
  source's managed directory, created `0700` with files `0600`. Run
  `gbrain doctor` to check the permissions of anything else.
- **What leaves the machine.** Syncing itself sends nothing anywhere. After
  import the pages are ordinary connector pages, so the same optional steps as for
  Google pages apply: **embeddings** send page text to your configured embedding
  provider (use `--no-embed` / a local model to avoid it), and **atom
  extraction** sends the text of `email` and `meeting` pages (subjects, bodies,
  participants, up to `cycle.extract_atoms.max_input_chars`) to your configured
  chat model under the auto-drain dollar cap. To keep Mail and Calendar pages out
  of atom extraction: `gbrain config set cycle.extract_atoms.connector_pages false`.
  See [spend controls](../operations/spend-controls.md#atom-extraction-auto-drain-cap-and-connector-pages).
- **Loop extraction is opt-in per source** (`--consent-loops-extraction`): without it no Mail text is sent to a model for open-loop extraction (see [Open loops](#open-loops-unanswered-mail)).
- Apple connector pages are marked untrusted external content, like Google's.
- Items that fail repeatedly are held after 3 runs (`gbrain sources status <id>`,
  `gbrain sources retry-held <id>`, doctor `connector_held_items`). A permission
  denial is a source-level problem, never a held item.

## Troubleshooting

| Code | Meaning | Fix |
|---|---|---|
| `unsupported_platform` | not macOS | run on the Mac that has the data |
| `permission_denied` | Calendar/Contacts access denied | see [Permissions](#permissions) |
| `automation_denied` | Mail scripting denied | Automation pane, enable Mail for the app |
| `mail_not_running_or_unconfigured` | Mail.app has no account / is not ready | open Mail, add an account, retry |
| `helper_timeout` | a helper ran over its 120 s limit | retry; narrow the window or mailboxes |
| `permission_not_determined` | macOS has not asked yet (not a denial) | run `gbrain apple setup` interactively and click Allow |
| `selection_not_found` | a configured calendar id or mailbox matches nothing | fix `--calendar-ids` / `--mail-mailboxes` |
| `macos_too_old` | the helper needs macOS 14+ / Command Line Tools 15+ | update macOS and the tools (`xcode-select --install`) |
| `helper_failed` | the helper crashed | install Xcode Command Line Tools 15+ (`xcode-select --install`) |
| `mail_confirmation_required` | `sources add` / `set-services` included Mail without `--confirm-mail` | confirm with the user, then add `--confirm-mail` |
| `extraction_consent_requires_identity` | `--consent-loops-extraction` without `--mail-owner-addresses` | pass the owner addresses with it |
| `malformed_output` | the helper printed something unparseable | retry once, then report the redacted output |
| `unknown_service` / `empty_services` | bad `--services` | pick from calendar, contacts, mail |
