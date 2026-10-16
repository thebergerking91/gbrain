// gbrain Apple connector: read-only Mail helper (JXA against Mail.app's public scripting dictionary).
//
// Usage (run by src/core/apple/readers/mail.ts, never from user input):
//   osascript -l JavaScript mail.js --probe
//   osascript -l JavaScript mail.js --since <ISO8601> --mailboxes INBOX,Sent
//
// Protocol: prints exactly ONE JSON document on stdout.
//   success: {"items":[AppleMailMessage...]}  exit 0
//   failure: {"error":{"code":"...","message":"..."}}  exit non-zero
//
// Read-only: only property reads and `whose` filters are used. Nothing is sent, moved,
// flagged, marked read, or deleted. Attachments are never touched (no `mailAttachments`
// access, no save). Bodies come from `content` (plain text) and are capped at BODY_CAP chars.
// Mail.app has no thread id in its public dictionary, so threadId is derived from the
// first RFC `References` id, else `In-Reply-To`, else the message's own Message-ID, else
// the normalized subject.
ObjC.import('Foundation');
ObjC.import('stdlib');

var BODY_CAP = 20000;

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

function mailIsRunning() {
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  var n = apps.count;
  for (var i = 0; i < n; i++) {
    var id = ObjC.unwrap(apps.objectAtIndex(i).bundleIdentifier);
    if (id === 'com.apple.mail') return true;
  }
  return false;
}

function parseArgs(argv) {
  var out = { probe: false, since: null, mailboxes: [] };
  for (var i = 0; i < argv.length; i++) {
    var a = String(argv[i]);
    if (a === '--') continue;
    if (a === '--probe') { out.probe = true; continue; }
    if (a === '--since' || a === '--mailboxes') {
      if (i + 1 >= argv.length) fail('helper_failed', 'missing value for ' + a, 2);
      var v = String(argv[++i]);
      if (a === '--since') out.since = v;
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

function addrList(recips) {
  var out = [];
  for (var i = 0; i < recips.length; i++) {
    var a = '';
    try { a = recips[i].address(); } catch (e) { a = ''; }
    if (a) out.push(String(a));
  }
  return out;
}

function resolveMailboxes(Mail, names) {
  var found = [];
  var seen = {};
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
    var accounts = Mail.accounts();
    for (var i = 0; i < accounts.length; i++) {
      var boxes = accounts[i].mailboxes();
      for (var j = 0; j < boxes.length; j++) {
        var bn = '';
        try { bn = String(boxes[j].name()); } catch (e) { continue; }
        if (bn.toLowerCase() === lower) add(name, boxes[j]);
      }
    }
  });
  return found;
}

function readMailbox(entry, since, items, seenIds) {
  var mb = entry.mb;
  var spec = mb.messages.whose({ dateReceived: { _greaterThan: since } });
  var ids = spec.id();
  var subjects = spec.subject();
  var senders = spec.sender();
  var dates = spec.dateReceived();
  var reads = spec.readStatus();
  for (var i = 0; i < ids.length; i++) {
    try {
      var m = mb.messages.byId(ids[i]);
      var headers = '';
      try { headers = String(m.allHeaders()); } catch (e) { headers = ''; }
      var rfcId = firstMsgId(headerValue(headers, 'Message-ID'));
      var ref = firstMsgId(headerValue(headers, 'References'));
      var irt = firstMsgId(headerValue(headers, 'In-Reply-To'));
      var subject = String(subjects[i] || '');
      var threadId = ref || irt || rfcId || ('subject:' + normSubject(subject));
      var id = rfcId || ('mail-id:' + entry.label + ':' + ids[i]);
      if (seenIds[id]) continue;
      seenIds[id] = true;
      var body = '';
      try { body = String(m.content() || ''); } catch (e) { body = ''; }
      if (body.length > BODY_CAP) body = body.slice(0, BODY_CAP);
      items.push({
        id: id,
        threadId: threadId,
        mailbox: entry.label,
        subject: subject,
        from: String(senders[i] || ''),
        to: addrList(m.toRecipients()),
        cc: addrList(m.ccRecipients()),
        date: new Date(dates[i]).toISOString(),
        body: body,
        read: !!reads[i]
      });
    } catch (e) {
      // A single unreadable message is skipped; mailbox-level failures propagate.
    }
  }
}

function run(argv) {
  var args = parseArgs(argv);

  if (args.probe) {
    // Do not launch Mail just to probe: report "not running" instead.
    if (!mailIsRunning()) {
      fail('mail_not_running_or_unconfigured', 'Mail.app is not running. Open Mail and let it finish setting up an account.');
    }
  }

  var Mail;
  try {
    Mail = Application('Mail');
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
  try {
    var entries = resolveMailboxes(Mail, args.mailboxes);
    var seenIds = {};
    entries.forEach(function (entry) { readMailbox(entry, since, items, seenIds); });
  } catch (e2) {
    var c2 = classify(e2);
    fail(c2[0], c2[1]);
  }
  items.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  emit({ items: items }, 0);
}
