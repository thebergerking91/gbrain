// gbrain Apple connector: read-only Mail helper (JXA against Mail.app's public scripting dictionary).
//
// Usage (run by src/core/apple/readers/mail.ts, never from user input):
//   osascript -l JavaScript mail.js --probe
//   osascript -l JavaScript mail.js --since <ISO8601> --mailboxes INBOX,Sent [--max 500]
//
// Protocol: prints exactly ONE JSON document on stdout.
//   success: {"items":[AppleMailMessage...], "truncated":bool, "unavailable":[threadId...], "incomplete":bool}  exit 0
//     truncated   more than --max messages matched: the OLDEST --max are returned (resume from the newest returned).
//     unavailable threads with a message that could not be read: the caller must not treat them as deleted.
//     incomplete  a message could not even be attributed to a thread: the caller must not delete anything.
//   failure: {"error":{"code":"...","message":"..."}}  exit non-zero
//
// Mail.app is NEVER launched: `Application('Mail').running()` is checked first (probe and sync), and a
// closed Mail is reported as mail_not_running_or_unconfigured. Properties are fetched in bulk
// (one Apple event per property over the filtered message set), not per message.
// Read-only: only property reads and `whose` filters are used. Nothing is sent, moved,
// flagged, marked read, or deleted. Attachments are never touched (no `mailAttachments`
// access, no save). Bodies come from `content` (plain text) and are capped at BODY_CAP chars.
// Mail.app has no thread id in its public dictionary, so threadId is derived from the
// first RFC `References` id, else `In-Reply-To`, else the message's own Message-ID, else
// the normalized subject.
ObjC.import('Foundation');
ObjC.import('stdlib');

var BODY_CAP = 20000;
var DEFAULT_MAX = 500;

function emit(doc, code) {
  var s = JSON.stringify(doc) + '\n';
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding));
  $.exit(code);
}

function fail(code, message, exitCode) {
  emit({ error: { code: code, message: String(message) } }, exitCode === undefined ? 1 : exitCode);
}

function classify(e) {
  var m = String((e && (e.message || e)) || e);
  if (/-1743|not authori[sz]ed/i.test(m)) {
    return ['automation_denied', 'Automation access to Mail is not granted (' + m + ').'];
  }
  if (/-600|isn.t running|application can.t be found|-10814/i.test(m)) {
    return ['mail_not_running_or_unconfigured', 'Mail.app is not available or not running (' + m + ').'];
  }
  return ['helper_failed', m];
}

function parseArgs(argv) {
  var out = { probe: false, since: null, mailboxes: [], max: DEFAULT_MAX };
  for (var i = 0; i < argv.length; i++) {
    var a = String(argv[i]);
    if (a === '--') continue;
    if (a === '--probe') { out.probe = true; continue; }
    if (a === '--since' || a === '--mailboxes' || a === '--max') {
      if (i + 1 >= argv.length) fail('helper_failed', 'missing value for ' + a, 2);
      var v = String(argv[++i]);
      if (a === '--since') out.since = v;
      else if (a === '--max') {
        var n = parseInt(v, 10);
        if (!(n >= 1)) fail('helper_failed', '--max must be a positive integer', 2);
        out.max = n;
      }
      else out.mailboxes = v.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
      continue;
    }
    fail('helper_failed', 'unknown argument: ' + a, 2);
  }
  return out;
}

function normSubject(s) {
  return String(s || '').replace(/^\s*((re|fwd?|aw|sv)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function headerValue(headers, name) {
  // Unfold continuation lines, then find the first matching header.
  var unfolded = String(headers || '').replace(/\r?\n[ \t]+/g, ' ');
  var re = new RegExp('^' + name + ':[ \\t]*(.*)$', 'im');
  var m = re.exec(unfolded);
  return m ? m[1].trim() : '';
}

function firstMsgId(s) {
  var m = /<[^>\s]+>/.exec(s || '');
  return m ? m[0] : '';
}

// Addresses of a To/Cc header (already unfolded), without per-recipient Apple events.
function addrsOfHeader(headers, name) {
  var v = headerValue(headers, name);
  var found = v.match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+/g);
  return found ? found : [];
}

function resolveMailboxes(Mail, names) {
  var found = [];
  var seen = {};
  var missing = [];
  function add(label, mb) {
    var key = label + '|' + (function () { try { return mb.id(); } catch (e) { return label; } })();
    if (seen[key]) return;
    seen[key] = true;
    found.push({ label: label, mb: mb });
  }
  names.forEach(function (name) {
    var lower = name.toLowerCase();
    if (lower === 'inbox') { add('INBOX', Mail.inbox); return; }
    if (lower === 'sent') { add('Sent', Mail.sentMailbox); return; }
    if (lower === 'drafts') { add('Drafts', Mail.draftsMailbox); return; }
    if (lower === 'junk') { add('Junk', Mail.junkMailbox); return; }
    if (lower === 'trash') { add('Trash', Mail.trash); return; }
    var before = found.length;
    var accounts = Mail.accounts();
    for (var i = 0; i < accounts.length; i++) {
      var boxes = accounts[i].mailboxes();
      for (var j = 0; j < boxes.length; j++) {
        var bn = '';
        try { bn = String(boxes[j].name()); } catch (e) { continue; }
        if (bn.toLowerCase() === lower) add(name, boxes[j]);
      }
    }
    if (found.length === before) missing.push(name);
  });
  // A configured mailbox that matches nothing would shrink the listing silently, and a --full
  // sweep reads a short listing as deletions: refuse instead.
  if (missing.length > 0) {
    fail('selection_not_found', 'No mailbox in Mail.app matches: ' + missing.join(', ') + '.');
  }
  return found;
}

function whoseSince(mb, since, until) {
  var after = { dateReceived: { _greaterThan: since } };
  if (!until) return mb.messages.whose(after);
  return mb.messages.whose({ _and: [after, { dateReceived: { _lessThanEquals: until } }] });
}

// Cheap pass: only the received dates of every matching message (one Apple event per mailbox).
function listDates(entries, since) {
  var all = [];
  entries.forEach(function (entry) {
    var dates = whoseSince(entry.mb, since, null).dateReceived();
    for (var i = 0; i < dates.length; i++) all.push(new Date(dates[i]).getTime());
  });
  all.sort(function (a, b) { return a - b; });
  return all;
}

function readMailbox(entry, since, until, items, seenIds, state) {
  var spec = whoseSince(entry.mb, since, until);
  var ids = spec.id();
  var rfcIds = spec.messageId();
  var subjects = spec.subject();
  var senders = spec.sender();
  var dates = spec.dateReceived();
  var reads = spec.readStatus();
  var heads = spec.allHeaders();
  var bodies = spec.content();
  for (var i = 0; i < ids.length; i++) {
    var threadId = '';
    try {
      var headers = String(heads[i] || '');
      var rfcId = firstMsgId(String(rfcIds[i] || '')) || firstMsgId(headerValue(headers, 'Message-ID'));
      var ref = firstMsgId(headerValue(headers, 'References'));
      var irt = firstMsgId(headerValue(headers, 'In-Reply-To'));
      var subject = String(subjects[i] || '');
      threadId = ref || irt || rfcId || ('subject:' + normSubject(subject));
      var id = rfcId || ('mail-id:' + entry.label + ':' + ids[i]);
      if (seenIds[id]) continue;
      var body = String(bodies[i] || '');
      if (body.length > BODY_CAP) body = body.slice(0, BODY_CAP);
      var item = {
        id: id,
        threadId: threadId,
        mailbox: entry.label,
        subject: subject,
        from: String(senders[i] || ''),
        to: addrsOfHeader(headers, 'To'),
        cc: addrsOfHeader(headers, 'Cc'),
        date: new Date(dates[i]).toISOString(),
        body: body,
        read: !!reads[i]
      };
      seenIds[id] = true;
      items.push(item);
    } catch (e) {
      // An unreadable message must not make its thread look deleted: report the thread as
      // unavailable (or the whole listing as incomplete when even the thread is unknown).
      if (threadId) state.unavailable[threadId] = true;
      else state.incomplete = true;
    }
  }
}

function run(argv) {
  var args = parseArgs(argv);

  var Mail;
  try {
    Mail = Application('Mail');
    // running() does not launch Mail. A closed Mail is reported, never started, on probe AND sync.
    if (!Mail.running()) {
      fail('mail_not_running_or_unconfigured', 'Mail.app is not running. Open Mail and let it finish setting up an account.');
    }
    var accts = Mail.accounts();
    if (accts.length === 0) {
      fail('mail_not_running_or_unconfigured', 'Mail.app has no accounts configured.');
    }
  } catch (e) {
    var c = classify(e);
    fail(c[0], c[1]);
  }
  if (args.probe) emit({ items: [], status: 'available' }, 0);

  if (!args.since) fail('helper_failed', '--since is required', 2);
  var since = new Date(args.since);
  if (isNaN(since.getTime())) fail('helper_failed', '--since must be ISO8601', 2);
  if (args.mailboxes.length === 0) fail('helper_failed', '--mailboxes is required', 2);

  var items = [];
  var state = { unavailable: {}, incomplete: false };
  var truncated = false;
  try {
    var entries = resolveMailboxes(Mail, args.mailboxes);
    var until = null;
    var stamps = listDates(entries, since);
    if (stamps.length > args.max) {
      // Over the cap: take the OLDEST --max so the caller can resume from the newest returned.
      truncated = true;
      until = new Date(stamps[args.max - 1]);
    }
    var seenIds = {};
    entries.forEach(function (entry) { readMailbox(entry, since, until, items, seenIds, state); });
  } catch (e2) {
    var c2 = classify(e2);
    fail(c2[0], c2[1]);
  }
  items.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  emit({ items: items, truncated: truncated, unavailable: Object.keys(state.unavailable), incomplete: state.incomplete }, 0);
}
