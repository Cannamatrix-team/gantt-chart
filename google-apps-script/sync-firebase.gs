/**
 * Cannamatrix Gantt Chart — Firebase → Google Sheets + Doc Sync
 *
 * Fetches all data from Firebase Realtime Database and writes it to:
 *   - Google Sheets (Tasks, Sprints, Baselines, Team tabs)
 *   - Google Doc (formatted project status readable by AI)
 *   - Google Calendar (all-day events)
 *
 * Setup: Extensions → Apps Script → paste this → set 5-min trigger on syncFromFirebase
 */

var FIREBASE_BASE = 'https://cannamatrix-gantt-default-rtdb.firebaseio.com';

// Fallback status labels if Firebase settings haven't been configured
var DEFAULT_STATUS_LABELS = {
  '':            '-',
  'not_started': 'Not Started',
  'to_do':       'To Do',
  'in_progress': 'In Progress',
  'complete':    'Complete',
  'on_hold':     'On Hold',
  'at_risk':     'At Risk',
  'blocked':     'Blocked',
  'unapproved':  'Unapproved/TBD'
};

var STATUS_CALENDAR_COLORS = {
  'In Progress':    CalendarApp.EventColor.CYAN,
  'To Do':          CalendarApp.EventColor.BANANA,
  'Complete':       CalendarApp.EventColor.SAGE,
  'Unapproved/TBD': CalendarApp.EventColor.GRAPE,
  'Not Started':    CalendarApp.EventColor.PALE_BLUE,
  'On Hold':        CalendarApp.EventColor.ORANGE,
  'At Risk':        CalendarApp.EventColor.RED,
  'Blocked':        CalendarApp.EventColor.MAUVE
};

var TASK_HEADERS = ['WBS', 'Level', 'Name', 'Status', 'Assigned', 'Start', 'End', 'Duration (days)', 'Dependencies', 'Auto Rollup', 'Notes'];
var SPRINT_HEADERS = ['Name', 'Start', 'End', 'Color'];
var BASELINE_HEADERS = ['Baseline', 'Saved', 'WBS', 'Name', 'Start', 'End'];
var TEAM_HEADERS = ['Name'];

/**
 * Main entry point — call this from the trigger.
 */
function syncFromFirebase() {
  // Fetch all data once, pass to each sync function
  var allData = {
    tasks:     fetchJson_(FIREBASE_BASE + '/tasks.json') || {},
    sprints:   fetchJson_(FIREBASE_BASE + '/sprints.json') || {},
    baselines: fetchJson_(FIREBASE_BASE + '/baselines.json') || {},
    team:      fetchJson_(FIREBASE_BASE + '/team.json') || [],
    settings:  fetchJson_(FIREBASE_BASE + '/settings.json') || {}
  };
  allData.statusDefs = buildStatusDefs_(allData.settings);

  syncTasksSheet_(allData);
  syncSprintsSheet_(allData);
  syncBaselinesSheet_(allData);
  syncTeamSheet_(allData);
  syncDoc_(allData);
  syncCalendar_(allData);
  stampLastSynced_();
}

/**
 * Build status key → label map from Firebase settings, falling back to defaults.
 */
function buildStatusDefs_(settings) {
  var defs = {};
  var src = (settings && settings.statuses) || null;
  if (src && typeof src === 'object') {
    var keys = Object.keys(src);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var entry = src[k];
      defs[k] = (entry && entry.label) ? entry.label : (DEFAULT_STATUS_LABELS[k] || k);
    }
  } else {
    var defKeys = Object.keys(DEFAULT_STATUS_LABELS);
    for (var j = 0; j < defKeys.length; j++) {
      defs[defKeys[j]] = DEFAULT_STATUS_LABELS[defKeys[j]];
    }
  }
  // Always include empty key
  if (!defs['']) defs[''] = '-';
  return defs;
}

/**
 * Resolve a status key to its display label.
 */
function resolveStatus_(key, statusDefs) {
  if (!key) return '';
  if (statusDefs[key]) return statusDefs[key];
  if (DEFAULT_STATUS_LABELS[key]) return DEFAULT_STATUS_LABELS[key];
  return key;
}

/**
 * Build common task rows from raw Firebase data.
 */
function buildTaskRows_(data, statusDefs) {
  var idToWbs = {};
  var keys = Object.keys(data.tasks);
  for (var k = 0; k < keys.length; k++) {
    idToWbs[keys[k]] = data.tasks[keys[k]].wbs || '';
  }

  var rows = [];
  for (var i = 0; i < keys.length; i++) {
    var t = data.tasks[keys[i]];
    var deps = '';
    if (Array.isArray(t.dependencies)) {
      deps = t.dependencies.map(function(d) { return idToWbs[d] || d; }).join(', ');
    } else if (t.dependencies) {
      deps = String(t.dependencies);
    }
    rows.push({
      wbs:        t.wbs || '',
      level:      t.level || String(t.wbs || '').split('.').length,
      name:       t.name || '',
      status:     resolveStatus_(t.status, statusDefs),
      statusKey:  t.status || '',
      assigned:   t.assigned || '',
      start:      t.start || '',
      end:        t.end || '',
      duration:   t.duration != null ? t.duration : '',
      deps:       deps,
      autoRollup: t.autoRollup !== false ? 'Yes' : 'No',
      notes:      t.notes || ''
    });
  }
  rows.sort(compareWbs_);
  return rows;
}

// ── Sheets Sync ──────────────────────────────────────────

/**
 * Write tasks to "Tasks" sheet with all fields.
 */
function syncTasksSheet_(data) {
  var rows = buildTaskRows_(data, data.statusDefs);

  var sheet = getOrCreateSheet_('Tasks');
  sheet.clearContents();

  var output = [TASK_HEADERS];
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j];
    output.push([r.wbs, r.level, r.name, r.status, r.assigned, r.start, r.end, r.duration, r.deps, r.autoRollup, r.notes]);
  }

  sheet.getRange(1, 1, output.length, output[0].length).setValues(output);
}

/**
 * Write sprints to "Sprints" sheet.
 */
function syncSprintsSheet_(data) {
  var sprintKeys = Object.keys(data.sprints);
  if (!sprintKeys.length) return;

  var rows = [];
  for (var i = 0; i < sprintKeys.length; i++) {
    var s = data.sprints[sprintKeys[i]];
    rows.push([s.name || '', s.start || '', s.end || '', s.color || '']);
  }
  rows.sort(function(a, b) { return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0; });

  var sheet = getOrCreateSheet_('Sprints');
  sheet.clearContents();

  var output = [SPRINT_HEADERS];
  for (var j = 0; j < rows.length; j++) {
    output.push(rows[j]);
  }
  sheet.getRange(1, 1, output.length, output[0].length).setValues(output);
}

/**
 * Write baselines to "Baselines" sheet.
 */
function syncBaselinesSheet_(data) {
  var blKeys = Object.keys(data.baselines);
  if (!blKeys.length) return;

  var sheet = getOrCreateSheet_('Baselines');
  sheet.clearContents();

  var output = [BASELINE_HEADERS];
  for (var i = 0; i < blKeys.length; i++) {
    var bl = data.baselines[blKeys[i]];
    var blName = bl.name || blKeys[i];
    var blDate = bl.date || '';
    if (blDate) {
      try { blDate = new Date(blDate).toLocaleString('en-US', { timeZone: 'America/New_York' }); } catch(e) {}
    }
    var blTasks = bl.tasks || [];
    if (!Array.isArray(blTasks)) blTasks = [];
    for (var j = 0; j < blTasks.length; j++) {
      var bt = blTasks[j];
      output.push([
        blName,
        blDate,
        bt.wbs || '',
        bt.name || '',
        bt.start || '',
        bt.end || ''
      ]);
    }
  }
  sheet.getRange(1, 1, output.length, output[0].length).setValues(output);
}

/**
 * Write team members to "Team" sheet.
 */
function syncTeamSheet_(data) {
  var members = [];
  if (Array.isArray(data.team)) {
    members = data.team;
  } else if (data.team && typeof data.team === 'object') {
    members = Object.values(data.team).filter(function(v) { return typeof v === 'string'; });
  }
  if (!members.length) return;

  var sheet = getOrCreateSheet_('Team');
  sheet.clearContents();

  var output = [TEAM_HEADERS];
  for (var i = 0; i < members.length; i++) {
    output.push([members[i]]);
  }
  sheet.getRange(1, 1, output.length, output[0].length).setValues(output);
}

/**
 * Write "Last synced" timestamp to the Tasks sheet.
 */
function stampLastSynced_() {
  var sheet = getOrCreateSheet_('Tasks');
  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 2, 1).setValue('Last synced: ' + new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

// ── Google Doc Sync ──────────────────────────────────────

/**
 * Sync all gantt chart data to a Google Doc so Claude AI can read project status.
 * Creates the doc on first run and stores its ID in script properties.
 */
function syncDoc_(data) {
  var rows = buildTaskRows_(data, data.statusDefs);

  var doc = getOrCreateDoc_();
  var body = doc.getBody();
  body.clear();

  var now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  body.appendParagraph('Cannamatrix Gantt Chart — Project Status')
      .setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph('Auto-synced from Firebase every 5 minutes. Last updated: ' + now)
      .setItalic(true);
  body.appendParagraph('');

  // ── Team ──
  var members = [];
  if (Array.isArray(data.team)) members = data.team;
  else if (data.team && typeof data.team === 'object') {
    members = Object.values(data.team).filter(function(v) { return typeof v === 'string'; });
  }
  if (members.length) {
    body.appendParagraph('Team').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    body.appendParagraph(members.join(', '));
    body.appendParagraph('');
  }

  // ── Tasks ──
  body.appendParagraph('Tasks').setHeading(DocumentApp.ParagraphHeading.HEADING2);

  if (rows.length === 0) {
    body.appendParagraph('No tasks defined.');
  } else {
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var indent = '';
      for (var d = 1; d < r.level; d++) indent += '    ';

      var titleLine = indent + r.wbs + '  ' + r.name;
      var para = body.appendParagraph(titleLine);
      if (r.level === 1) {
        para.setBold(true);
        para.setFontSize(13);
      }

      var details = [];
      if (r.status) details.push('Status: ' + r.status);
      if (r.assigned) details.push('Assigned: ' + r.assigned);
      details.push(r.start + ' → ' + r.end);
      if (r.duration) details.push(r.duration + 'd');
      if (r.deps) details.push('Depends on: ' + r.deps);
      if (r.autoRollup === 'Yes' && r.level === 1) details.push('Auto rollup');

      var detailPara = body.appendParagraph(indent + '    ' + details.join('  |  '));
      detailPara.setFontSize(9);
      detailPara.setForegroundColor('#666666');

      if (r.notes) {
        var notesPara = body.appendParagraph(indent + '    Notes: ' + r.notes);
        notesPara.setFontSize(9);
        notesPara.setForegroundColor('#888888');
        notesPara.setItalic(true);
      }
    }
  }

  body.appendParagraph('');

  // ── Sprints ──
  body.appendParagraph('Sprints').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  var sprintKeys = Object.keys(data.sprints);
  if (sprintKeys.length === 0) {
    body.appendParagraph('No sprints defined.');
  } else {
    var sprintRows = [];
    for (var si = 0; si < sprintKeys.length; si++) {
      var s = data.sprints[sprintKeys[si]];
      sprintRows.push({ name: s.name || '', start: s.start || '', end: s.end || '' });
    }
    sprintRows.sort(function(a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
    for (var sj = 0; sj < sprintRows.length; sj++) {
      var sp = sprintRows[sj];
      body.appendParagraph(sp.name + '    ' + sp.start + ' → ' + sp.end);
    }
  }

  // ── Baselines ──
  var blKeys = Object.keys(data.baselines);
  if (blKeys.length) {
    body.appendParagraph('');
    body.appendParagraph('Baselines').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    for (var bi = 0; bi < blKeys.length; bi++) {
      var bl = data.baselines[blKeys[bi]];
      var blDate = bl.date || '';
      if (blDate) {
        try { blDate = new Date(blDate).toLocaleString('en-US', { timeZone: 'America/New_York' }); } catch(e) {}
      }
      body.appendParagraph((bl.name || blKeys[bi]) + '  (saved ' + blDate + ')')
          .setHeading(DocumentApp.ParagraphHeading.HEADING3);

      var blTasks = bl.tasks || [];
      if (!Array.isArray(blTasks)) blTasks = [];
      for (var bj = 0; bj < blTasks.length; bj++) {
        var bt = blTasks[bj];
        var blLine = (bt.wbs || '') + '  ' + (bt.name || '') + '    ' +
          (bt.start || '') + ' → ' + (bt.end || '');
        var blPara = body.appendParagraph('    ' + blLine);
        blPara.setFontSize(10);
        blPara.setForegroundColor('#555555');
      }
    }
  }

  // ── Summary stats ──
  body.appendParagraph('');
  body.appendParagraph('Summary').setHeading(DocumentApp.ParagraphHeading.HEADING2);

  // Count statuses dynamically
  var statusCounts = {};
  var leafCount = 0;
  for (var ci = 0; ci < rows.length; ci++) {
    // Only count leaf tasks (no children) for meaningful stats
    var isParent = false;
    var thisWbs = rows[ci].wbs;
    for (var ck = 0; ck < rows.length; ck++) {
      if (ck !== ci && rows[ck].wbs.indexOf(thisWbs + '.') === 0) {
        isParent = true;
        break;
      }
    }
    if (isParent) continue;
    leafCount++;
    var label = rows[ci].status || 'No Status';
    statusCounts[label] = (statusCounts[label] || 0) + 1;
  }

  body.appendParagraph('Total tasks: ' + rows.length + '  (leaf tasks: ' + leafCount + ')');

  var countParts = [];
  var countKeys = Object.keys(statusCounts);
  countKeys.sort();
  for (var sc = 0; sc < countKeys.length; sc++) {
    countParts.push(countKeys[sc] + ': ' + statusCounts[countKeys[sc]]);
  }
  if (countParts.length) {
    body.appendParagraph('Leaf task statuses: ' + countParts.join('  |  '));
  }

  // Assignee workload
  var assigneeTasks = {};
  for (var ai = 0; ai < rows.length; ai++) {
    if (!rows[ai].assigned) continue;
    var assignees = rows[ai].assigned.split(',');
    for (var aj = 0; aj < assignees.length; aj++) {
      var assignee = assignees[aj].replace(/^\s+|\s+$/g, '');
      if (!assignee) continue;
      if (!assigneeTasks[assignee]) assigneeTasks[assignee] = 0;
      assigneeTasks[assignee]++;
    }
  }
  var assigneeKeys = Object.keys(assigneeTasks);
  if (assigneeKeys.length) {
    assigneeKeys.sort();
    var assigneeParts = [];
    for (var ak = 0; ak < assigneeKeys.length; ak++) {
      assigneeParts.push(assigneeKeys[ak] + ': ' + assigneeTasks[assigneeKeys[ak]] + ' tasks');
    }
    body.appendParagraph('Assignee workload: ' + assigneeParts.join('  |  '));
  }

  doc.saveAndClose();
}

/**
 * Get or create the "Cannamatrix Gantt — Project Status" Google Doc.
 */
function getOrCreateDoc_() {
  var props = PropertiesService.getScriptProperties();
  var docId = props.getProperty('GANTT_DOC_ID');

  if (docId) {
    try {
      return DocumentApp.openById(docId);
    } catch (e) {
      // Doc was deleted or inaccessible, create a new one
    }
  }

  var newDoc = DocumentApp.create('Cannamatrix Gantt — Project Status');
  props.setProperty('GANTT_DOC_ID', newDoc.getId());
  Logger.log('Created status doc: ' + newDoc.getUrl());
  return newDoc;
}

// ── Calendar Sync ────────────────────────────────────────

var FIREBASE_TAG_RE = /\[firebase:([^\]]+)\]/;

/**
 * Sync tasks and sprints to a Google Calendar as all-day events.
 */
function syncCalendar_(data) {
  var cal = getOrCreateCalendar_();

  // Build map of existing calendar events keyed by firebase tag
  var now = new Date();
  var windowStart = new Date(now.getFullYear() - 1, 0, 1);
  var windowEnd   = new Date(now.getFullYear() + 2, 11, 31);
  var allEvents = cal.getEvents(windowStart, windowEnd);

  var eventMap = {};  // firebaseKey → CalendarEvent
  for (var i = 0; i < allEvents.length; i++) {
    var desc = allEvents[i].getDescription() || '';
    var match = desc.match(FIREBASE_TAG_RE);
    if (match) {
      eventMap[match[1]] = allEvents[i];
    }
  }

  var seen = {};  // track which firebase keys still exist

  // ── Sync tasks ──
  var taskKeys = Object.keys(data.tasks);
  for (var ti = 0; ti < taskKeys.length; ti++) {
    var key = taskKeys[ti];
    var t = data.tasks[key];
    if (!t.start || !t.end) continue;

    var tag = 't_' + key;
    seen[tag] = true;

    var title = '[' + (t.wbs || '?') + '] ' + (t.name || '');
    var status = resolveStatus_(t.status, data.statusDefs);
    var calBody = 'Status: ' + status +
      '\nAssigned: ' + (t.assigned || '') +
      (t.notes ? '\nNotes: ' + t.notes : '') +
      '\n\n[firebase:' + tag + ']';
    var color = STATUS_CALENDAR_COLORS[status] || CalendarApp.EventColor.PALE_BLUE;

    var startDate = new Date(t.start);
    var endDate   = new Date(t.end);
    endDate.setDate(endDate.getDate() + 1); // exclusive end

    var ev = eventMap[tag];
    if (ev) {
      if (ev.getTitle() !== title) ev.setTitle(title);
      if (ev.getDescription() !== calBody) ev.setDescription(calBody);
      ev.setAllDayDates(startDate, endDate);
      ev.setColor(color);
    } else {
      ev = cal.createAllDayEvent(title, startDate, endDate, { description: calBody });
      ev.setColor(color);
    }
  }

  // ── Sync sprints ──
  var sprintKeys = Object.keys(data.sprints);
  for (var si = 0; si < sprintKeys.length; si++) {
    var sKey = sprintKeys[si];
    var s = data.sprints[sprintKeys[si]];
    if (!s.start || !s.end) continue;

    var sTag = 'sp_' + sKey;
    seen[sTag] = true;

    var sTitle = s.name || 'Sprint';
    var sBody  = '[firebase:' + sTag + ']';

    var sStart = new Date(s.start);
    var sEnd   = new Date(s.end);
    sEnd.setDate(sEnd.getDate() + 1);

    var sEv = eventMap[sTag];
    if (sEv) {
      if (sEv.getTitle() !== sTitle) sEv.setTitle(sTitle);
      if (sEv.getDescription() !== sBody) sEv.setDescription(sBody);
      sEv.setAllDayDates(sStart, sEnd);
      sEv.setColor(CalendarApp.EventColor.BLUE);
    } else {
      sEv = cal.createAllDayEvent(sTitle, sStart, sEnd, { description: sBody });
      sEv.setColor(CalendarApp.EventColor.BLUE);
    }
  }

  // ── Delete orphaned events ──
  var orphanKeys = Object.keys(eventMap);
  for (var oi = 0; oi < orphanKeys.length; oi++) {
    if (!seen[orphanKeys[oi]]) {
      eventMap[orphanKeys[oi]].deleteEvent();
    }
  }
}

/**
 * Get or create the "Cannamatrix Gantt" calendar.
 */
function getOrCreateCalendar_() {
  var props = PropertiesService.getScriptProperties();
  var calId = props.getProperty('GANTT_CALENDAR_ID');

  if (calId) {
    var cal = CalendarApp.getCalendarById(calId);
    if (cal) return cal;
  }

  var newCal = CalendarApp.createCalendar('Cannamatrix Gantt');
  props.setProperty('GANTT_CALENDAR_ID', newCal.getId());
  return newCal;
}

// ── Helpers ──────────────────────────────────────────────

function fetchJson_(url) {
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    Logger.log('Fetch failed: ' + resp.getResponseCode() + ' ' + resp.getContentText());
    return null;
  }
  return JSON.parse(resp.getContentText());
}

/**
 * Get sheet by name; if it doesn't exist, create it.
 * Also renames "Sheet1" to "Tasks" on first run.
 */
function getOrCreateSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (sheet) return sheet;

  // On first run the default tab is "Sheet1" — rename it for Tasks
  if (name === 'Tasks') {
    var sheet1 = ss.getSheetByName('Sheet1');
    if (sheet1) {
      sheet1.setName('Tasks');
      return sheet1;
    }
  }

  return ss.insertSheet(name);
}

/**
 * Compare WBS strings numerically (e.g. "1.2" < "1.10" < "2").
 */
function compareWbs_(a, b) {
  var pa = String(a.wbs).split('.');
  var pb = String(b.wbs).split('.');
  var len = Math.max(pa.length, pb.length);
  for (var i = 0; i < len; i++) {
    var na = parseInt(pa[i], 10) || 0;
    var nb = parseInt(pb[i], 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}
