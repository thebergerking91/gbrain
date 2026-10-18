// gbrain Apple connector: read-only Mail helper (JXA against Mail.app's public scripting dictionary).
//
// Usage (run by src/core/apple/readers/mail.ts, never from user input):
//   osascript -l JavaScript mail.js --probe
//   osascript -l JavaScript mail.js --since <ISO8601> --mailboxes INBOX,Sent [--max 500] [--budget-ms 45000]
//
// Protocol: prints exactly ONE JSON document on stdout.
//   success: {"items":[AppleMailMessage...], "truncated":bool, "budget_exhausted":bool, "unavailable":[threadId...], "incomplete":bool}  exit 0
//     truncated   more messages matched than were returned (the --max cap, or the --budget-ms body budget ran
//                 out, budget_exhausted:true): the OLDEST ones are returned (resume from the newest returned).
//     unavailable threads with a message that could not be read: the caller must not treat them as deleted.
//     incomplete  a message could not even be attributed to a thread: the caller must not delete anything.
//   failure: {"error":{"code":"...","message":"..."}}  exit non-zero
//
// Mail.app is NEVER launched: `Application('Mail').running()` is checked first (probe and sync), and a
// closed Mail is reported as mail_not_running_or_unconfigured. Properties are fetched in bulk
// (one Apple event per property over the filtered message set), not per message. Bodies are the
// exception: Mail.app can take ~20 s to produce `content` for one HTML newsletter (observed on a
// live Mac, cached or not), so bodies are fetched in small bulk batches under a wall-clock budget
// (--budget-ms, default 45 s, counted from process start). When the budget runs out the messages read so far (the oldest, in
// (date,id) order) are returned with truncated:true and budget_exhausted:true; the caller resumes
// from the last one on its next run, so a slow mailbox drains over several runs instead of timing out.
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
var DEFAULT_BUDGET_MS = 45000;
// Messages per body batch: one slow HTML body is ~20 s, so even a batch of all-slow messages started at
// the budget's edge (45 s + 3 × 20 s) finishes inside the caller's 120 s helper timeout.
var BODY_BATCH = 3;

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
  var out = { probe: false, since: null, mailboxes: [], max: DEFAULT_MAX, afterDate: null, afterId: null, budgetMs: DEFAULT_BUDGET_MS };
  for (var i = 0; i < argv.length; i++) {
    var a = String(argv[i]);
    if (a === '--') continue;
    if (a === '--probe') { out.probe = true; continue; }
    if (a === '--since' || a === '--mailboxes' || a === '--max' || a === '--after-date' || a === '--after-id' || a === '--budget-ms') {
      if (i + 1 >= argv.length) fail('helper_failed', 'missing value for ' + a, 2);
      var v = String(argv[++i]);
      if (a === '--since') out.since = v;
      else if (a === '--after-date') out.afterDate = v;
      else if (a === '--after-id') out.afterId = v;
      else if (a === '--max') {
        var n = parseInt(v, 10);
        if (!(n >= 1)) fail('helper_failed', '--max must be a positive integer', 2);
        out.max = n;
      }
      else if (a === '--budget-ms') {
        var b = parseInt(v, 10);
        if (!(b >= 1)) fail('helper_failed', '--budget-ms must be a positive integer', 2);
        out.budgetMs = b;
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

// Header-only automation verdicts for open-loop tracking (no body is read for them).
//   automated: RFC 3834 Auto-Submitted other than "no", or a text/calendar message.
//   bulk:      List-Unsubscribe, List-Id, Precedence bulk/list/junk, or a no-reply Reply-To.
function automationFlags(headers) {
  var auto = headerValue(headers, 'Auto-Submitted').toLowerCase();
  var ctype = headerValue(headers, 'Content-Type').toLowerCase();
  var precedence = headerValue(headers, 'Precedence').toLowerCase();
  var replyTo = headerValue(headers, 'Reply-To').toLowerCase();
  return {
    automated: (auto !== '' && auto !== 'no') || ctype.indexOf('text/calendar') >= 0,
    bulk: headerValue(headers, 'List-Unsubscribe') !== '' || headerValue(headers, 'List-Id') !== '' ||
      precedence === 'bulk' || precedence === 'list' || precedence === 'junk' ||
      /no-?reply|do-?not-?reply/.test(replyTo)
  };
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

function stableMessageId(label, appId, rfcId, headers) {
  return firstMsgId(String(rfcId || '')) || firstMsgId(headerValue(String(headers || ''), 'Message-ID')) || ('mail-id:' + label + ':' + appId);
}

// Metadata-only pass across the mailbox; bodies are fetched only for the bounded page below.
function listCandidates(entries, since) {
  var all = [];
  entries.forEach(function (entry) {
    var spec = whoseSince(entry.mb, since, null);
    var ids = spec.id();
    var rfcIds = spec.messageId();
    var heads = spec.allHeaders();
    var dates = spec.dateReceived();
    for (var i = 0; i < ids.length; i++) {
      var date = new Date(dates[i]).toISOString();
      all.push({ entry: entry, appId: ids[i], id: stableMessageId(entry.label, ids[i], rfcIds[i], heads[i]), date: date });
    }
  });
  return all;
}

function idClauses(appIds) {
  return { _or: appIds.map(function (id) { return { id: { _equals: id } }; }) };
}

// Metadata (everything but the body) for the selected messages of one mailbox, in bulk: one Apple
// event per property. Cheap even for hundreds of messages. Keyed by the Apple message id.
function readMeta(entry, appIds, metaByKey, state) {
  if (appIds.length === 0) return;
  var spec = entry.mb.messages.whose(idClauses(appIds));
  var ids = spec.id();
  var rfcIds = spec.messageId();
  var subjects = spec.subject();
  var senders = spec.sender();
  var dates = spec.dateReceived();
  var reads = spec.readStatus();
  var heads = spec.allHeaders();
  for (var i = 0; i < ids.length; i++) {
    var threadId = '';
    try {
      var headers = String(heads[i] || '');
      var id = stableMessageId(entry.label, ids[i], rfcIds[i], headers);
      var ref = firstMsgId(headerValue(headers, 'References'));
      var irt = firstMsgId(headerValue(headers, 'In-Reply-To'));
      var subject = String(subjects[i] || '');
      threadId = ref || irt || firstMsgId(String(rfcIds[i] || '')) || ('subject:' + normSubject(subject));
      metaByKey[entry.label + '|' + ids[i]] = {
        id: id,
        threadId: threadId,
        mailbox: entry.label,
        subject: subject,
        from: String(senders[i] || ''),
        to: addrsOfHeader(headers, 'To'),
        cc: addrsOfHeader(headers, 'Cc'),
        date: new Date(dates[i]).toISOString(),
        read: !!reads[i],
        automated: automationFlags(headers).automated,
        bulk: automationFlags(headers).bulk
      };
    } catch (e) {
      if (threadId) state.unavailable[threadId] = true;
      else state.incomplete = true;
    }
  }
}

// Bodies for one small batch of one mailbox's messages (one `content` Apple event for the batch).
function readBodies(entry, appIds, metaByKey, items, seenIds, state) {
  if (appIds.length === 0) return;
  var spec = entry.mb.messages.whose(idClauses(appIds));
  var ids = spec.id();
  var bodies;
  try {
    bodies = spec.content();
  } catch (eb) {
    // One unreadable body fails the whole bulk call: the batch's threads stay "unavailable" (present,
    // never deleted, re-read next run) instead of failing the run.
    for (var j = 0; j < ids.length; j++) {
      var m = metaByKey[entry.label + '|' + ids[j]];
      if (m) state.unavailable[m.threadId] = true;
    }
    return;
  }
  for (var i = 0; i < ids.length; i++) {
    var meta = metaByKey[entry.label + '|' + ids[i]];
    if (!meta) continue; // its metadata read already failed and was recorded
    try {
      if (seenIds[meta.id]) continue;
      var body = String(bodies[i] || '');
      if (body.length > BODY_CAP) body = body.slice(0, BODY_CAP);
      var item = {};
      for (var k in meta) item[k] = meta[k];
      item.body = body;
      items.push(item);
      seenIds[meta.id] = true;
    } catch (e) {
      state.unavailable[meta.threadId] = true;
    }
  }
}

// Bodies for the selected candidates, oldest first, in batches of BODY_BATCH, until the budget is spent.
// Returns true when it stopped early (the remaining candidates are left for the next run).
function readSelectedBodies(selected, metaByKey, items, seenIds, state, startedAt, budgetMs) {
  for (var i = 0; i < selected.length; i += BODY_BATCH) {
    if (i > 0 && Date.now() - startedAt > budgetMs) return true;
    var batch = selected.slice(i, i + BODY_BATCH);
    var byEntry = new Map();
    batch.forEach(function (c) {
      if (!byEntry.has(c.entry)) byEntry.set(c.entry, []);
      byEntry.get(c.entry).push(c.appId);
    });
    byEntry.forEach(function (appIds, entry) { readBodies(entry, appIds, metaByKey, items, seenIds, state); });
  }
  return false;
}

function run(argv) {
  var args = parseArgs(argv);
  // The budget counts from here: a slow `accounts()` (24 s seen on a live Mac) eats into it, so the
  // body batches that follow still finish inside the caller's helper timeout.
  var startedAt = Date.now();

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
  var budgetExhausted = false;
  try {
    var entries = resolveMailboxes(Mail, args.mailboxes);
    var candidates = listCandidates(entries, since);
    candidates.sort(function (a, b) { return a.date === b.date ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a.date < b.date ? -1 : 1); });
    var candidateIds = {};
    candidates = candidates.filter(function (c) {
      if (candidateIds[c.id]) return false;
      candidateIds[c.id] = true;
      return !args.afterDate || !args.afterId || c.date > args.afterDate || (c.date === args.afterDate && c.id > args.afterId);
    });
    truncated = candidates.length > args.max;
    var selected = candidates.slice(0, args.max);
    var selectedByEntry = new Map();
    selected.forEach(function (c) {
      if (!selectedByEntry.has(c.entry)) selectedByEntry.set(c.entry, []);
      selectedByEntry.get(c.entry).push(c.appId);
    });
    var metaByKey = {};
    entries.forEach(function (entry) { readMeta(entry, selectedByEntry.get(entry) || [], metaByKey, state); });
    var seenIds = {};
    budgetExhausted = readSelectedBodies(selected, metaByKey, items, seenIds, state, startedAt, args.budgetMs);
    if (budgetExhausted) truncated = true;
  } catch (e2) {
    var c2 = classify(e2);
    fail(c2[0], c2[1]);
  }
  items.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (args.afterDate && args.afterId) {
    items = items.filter(function (m) { return m.date > args.afterDate || (m.date === args.afterDate && m.id > args.afterId); });
  }
  truncated = truncated || items.length > args.max;
  if (items.length > args.max) items = items.slice(0, args.max);
  emit({ items: items, truncated: truncated, budget_exhausted: budgetExhausted, unavailable: Object.keys(state.unavailable), incomplete: state.incomplete }, 0);
}
