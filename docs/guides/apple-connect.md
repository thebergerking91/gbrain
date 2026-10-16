# Connecting Apple (Calendar, Contacts, Mail on macOS)

gbrain's apple connector ingests your Mac's Calendar events, Contacts and Mail
threads into your brain as pages, the same way the [google connector](google-connect.md)
does for Google accounts, but with no cloud account in the middle: it reads the
data already on your Mac.

It is **read-only** toward Apple, holds **no credentials**, and works **only on
macOS**. Each of the three services is opt-in per service.

## The fast path (one command)

```bash
gbrain apple setup
```

`setup` is idempotent (re-running is always safe) and walks the chain:

1. confirms **Mail** with you (it is the most sensitive service; see
   [Mail confirmation](#mail-confirmation)),
2. probes each selected service for the macOS permission it needs,
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

`--services` takes any subset of `calendar,contacts,mail` (default: all three).
An unknown or empty value is an error (`unknown_service` / `empty_services`);
it is never widened to "everything", because Mail and Contacts are private data.

Change them later with `gbrain sources set-services <source> --add|--remove <service>`.
**Removing a service never deletes pages**: the ones already imported stay, they
are simply no longer updated. A disabled service is not read at all (its helper
never runs and its permission is never requested). On a managed brain the
change starts a fresh sync cursor for the source and asks for `--yes` first.

## Source options

| Flag | Default | Meaning |
|---|---|---|
| `--services` | `calendar,contacts,mail` | which services to sync |
| `--account <label>` | `local` | a free label for this Mac's account; **not a credential** |
| `--history-days <n>` | 90 (max 3650) | calendar events this far back |
| `--future-days <n>` | 60 (max 3650) | calendar events this far ahead |
| `--calendar-ids <a,b>` | all calendars | only these calendars |
| `--contacts-dir <dir>` | `people` | where contact pages go (relative, lower-case segments) |
| `--mail-mailboxes <a,b>` | `INBOX,Sent` | which mailboxes |
| `--mail-days <n>` | 30 (max 365) | mail this far back |
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
session so macOS can prompt. If you previously denied it, `tccutil reset
Calendar` / `tccutil reset AddressBook` (all apps) clears the decision; for Mail,
remove the app from the Automation list and retry. Mail also needs Mail.app to
have at least one account configured and finished loading; gbrain never launches
Mail itself (`mail_not_running_or_unconfigured`).

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
page. `gbrain sync --source <id> --full` reconciles upstream deletions (and
refuses more than 200 removals unless `GBRAIN_ALLOW_MASS_RECONCILE=1`).
An identical re-run adds and modifies nothing.

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
| `helper_failed` | the helper crashed | install Xcode Command Line Tools (`xcode-select --install`) |
| `malformed_output` | the helper printed something unparseable | retry once, then report the redacted output |
| `unknown_service` / `empty_services` | bad `--services` | pick from calendar, contacts, mail |
