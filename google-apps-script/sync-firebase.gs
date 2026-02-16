/**
 * Cannamatrix Gantt Chart — Firebase → Google Sheets Sync
 *
 * Fetches task and sprint data from Firebase Realtime Database
 * and writes it to this spreadsheet on a 5-minute timer.
 *
 * Setup: Extensions → Apps Script → paste this → set trigger
 */

var FIREBASE_BASE = 'https://cannamatrix-gantt-default-rtdb.firebaseio.com';

var STATUS_LABELS = {
  'to_do':       'To Do',
  'in_progress': 'In Progress',
  'complete':    'Complete',
  'unapproved':  'Unapproved'
};

var STATUS_COLORS = {
  'In Progress': CalendarApp.EventColor.CYAN,
  'To Do':       CalendarApp.EventColor.BANANA,
  'Complete':    CalendarApp.EventColor.SAGE,
  'Unapproved':  CalendarApp.EventColor.GRAPE
};

var TASK_HEADERS = ['WBS', 'Name', 'Status', 'Assigned', 'Start', 'End', 'Duration', 'Progress', 'Dependencies'];
var SPRINT_HEADERS = ['Name', 'Start', 'End', 'Color'];

/**
 * Main entry point — call this from the trigger.
 */
function syncFromFirebase() {
  syncTasks_();
  syncSprints_();
  syncCalendar_();
  syncDoc_();
  stampLastSynced_();
}

/**
 * Fetch tasks, sort by WBS, write to "Tasks" sheet.
 */
function syncTasks_() {
  var data = fetchJson_(FIREBASE_BASE + '/tasks.json');
  if (!data) return;

  // Build ID → WBS lookup for resolving dependencies
  var idToWbs = {};
  var keys = Object.keys(data);
  for (var k = 0; k < keys.length; k++) {
    idToWbs[keys[k]] = data[keys[k]].wbs || '';
  }

  var rows = [];
  for (var i = 0; i < keys.length; i++) {
    var t = data[keys[i]];
    var deps = '';
    if (Array.isArray(t.dependencies)) {
      deps = t.dependencies.map(function(d) { return idToWbs[d] || d; }).join(', ');
    } else {
      deps = t.dependencies || '';
    }
    rows.push({
      wbs:          t.wbs || '',
      name:         t.name || '',
      status:       STATUS_LABELS[t.status] || t.status || '',
      assigned:     t.assigned || '',
      start:        t.start || '',
      end:          t.end || '',
      duration:     t.duration != null ? t.duration : '',
      progress:     t.progress != null ? t.progress + '%' : '',
      dependencies: deps
    });
  }

  rows.sort(compareWbs_);

  var sheet = getOrCreateSheet_('Tasks');
  sheet.clearContents();

  var output = [TASK_HEADERS];
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j];
    output.push([r.wbs, r.name, r.status, r.assigned, r.start, r.end, r.duration, r.progress, r.dependencies]);
  }

  sheet.getRange(1, 1, output.length, output[0].length).setValues(output);
}

/**
 * Fetch sprints, write to "Sprints" sheet.
 */
function syncSprints_() {
  var data = fetchJson_(FIREBASE_BASE + '/sprints.json');
  if (!data) return;

  var rows = [];
  var keys = Object.keys(data);
  for (var i = 0; i < keys.length; i++) {
    var s = data[keys[i]];
    rows.push([s.name || '', s.start || '', s.end || '', s.color || '']);
  }

  // Sort by start date
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
 * Write "Last synced" timestamp to the Tasks sheet.
 */
function stampLastSynced_() {
  var sheet = getOrCreateSheet_('Tasks');
  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 2, 1).setValue('Last synced: ' + new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

// ── Helpers ──────────────────────────────────────────────

function fetchJson_(url) {
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    Logger.log('Fetch failed: ' + resp.getResponseCode() + ' ' + resp.getContentText());
    return null;
  }
  var parsed = JSON.parse(resp.getContentText());
  return parsed;
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

// ── Google Doc Sync ──────────────────────────────────────

/**
 * Sync tasks and sprints to a Google Doc so Claude AI can read project status.
 * Creates the doc on first run and stores its ID in script properties.
 */
function syncDoc_() {
  var tasks   = fetchJson_(FIREBASE_BASE + '/tasks.json') || {};
  var sprints = fetchJson_(FIREBASE_BASE + '/sprints.json') || {};
  var settings = fetchJson_(FIREBASE_BASE + '/settings.json') || {};
  var statusDefs = (settings && settings.statuses) || STATUS_LABELS;

  var doc = getOrCreateDoc_();
  var body = doc.getBody();
  body.clear();

  var now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  body.appendParagraph('Cannamatrix Gantt Chart — Project Status')
      .setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph('Auto-synced from Firebase every 5 minutes. Last updated: ' + now)
      .setItalic(true);
  body.appendParagraph('');

  // ── Tasks ──
  var taskKeys = Object.keys(tasks);
  var rows = [];
  var idToWbs = {};
  for (var k = 0; k < taskKeys.length; k++) {
    idToWbs[taskKeys[k]] = tasks[taskKeys[k]].wbs || '';
  }
  for (var i = 0; i < taskKeys.length; i++) {
    var t = tasks[taskKeys[i]];
    var deps = '';
    if (Array.isArray(t.dependencies)) {
      deps = t.dependencies.map(function(d) { return idToWbs[d] || d; }).join(', ');
    }
    rows.push({
      wbs:      t.wbs || '',
      name:     t.name || '',
      level:    t.level || String(t.wbs || '').split('.').length,
      status:   resolveStatusLabel_(t.status, statusDefs),
      assigned: t.assigned || '',
      start:    t.start || '',
      end:      t.end || '',
      duration: t.duration != null ? t.duration : '',
      progress: t.progress != null ? t.progress : 0,
      deps:     deps
    });
  }
  rows.sort(compareWbs_);

  body.appendParagraph('Tasks').setHeading(DocumentApp.ParagraphHeading.HEADING2);

  if (rows.length === 0) {
    body.appendParagraph('No tasks defined.');
  } else {
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var indent = '';
      for (var d = 1; d < r.level; d++) indent += '    ';
      var line = indent + r.wbs + '  ' + r.name;
      var para = body.appendParagraph(line);
      para.setBold(r.level === 1);

      var details = [];
      if (r.status) details.push('Status: ' + r.status);
      if (r.assigned) details.push('Assigned: ' + r.assigned);
      details.push('Dates: ' + r.start + ' → ' + r.end);
      if (r.duration) details.push('Duration: ' + r.duration + 'd');
      details.push('Progress: ' + r.progress + '%');
      if (r.deps) details.push('Depends on: ' + r.deps);

      var detailPara = body.appendParagraph(indent + '    ' + details.join('  |  '));
      detailPara.setFontSize(9);
      detailPara.setForegroundColor('#666666');
    }
  }

  body.appendParagraph('');

  // ── Sprints ──
  body.appendParagraph('Sprints').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  var sprintKeys = Object.keys(sprints);
  if (sprintKeys.length === 0) {
    body.appendParagraph('No sprints defined.');
  } else {
    var sprintRows = [];
    for (var si = 0; si < sprintKeys.length; si++) {
      var s = sprints[sprintKeys[si]];
      sprintRows.push({ name: s.name || '', start: s.start || '', end: s.end || '' });
    }
    sprintRows.sort(function(a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
    for (var sj = 0; sj < sprintRows.length; sj++) {
      var sp = sprintRows[sj];
      body.appendParagraph(sp.name + '    ' + sp.start + ' → ' + sp.end);
    }
  }

  // ── Summary stats ──
  body.appendParagraph('');
  body.appendParagraph('Summary').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  var totalTasks = rows.length;
  var completedCount = 0, inProgressCount = 0, blockedCount = 0, atRiskCount = 0;
  for (var ci = 0; ci < rows.length; ci++) {
    var st = rows[ci].status.toLowerCase();
    if (st === 'complete') completedCount++;
    else if (st === 'in progress') inProgressCount++;
    else if (st === 'blocked') blockedCount++;
    else if (st === 'at risk') atRiskCount++;
  }
  body.appendParagraph('Total tasks: ' + totalTasks);
  body.appendParagraph('Completed: ' + completedCount + '  |  In Progress: ' + inProgressCount +
    '  |  Blocked: ' + blockedCount + '  |  At Risk: ' + atRiskCount);

  doc.saveAndClose();
}

/**
 * Resolve a status key to its display label.
 */
function resolveStatusLabel_(statusKey, statusDefs) {
  if (!statusKey) return '';
  if (statusDefs && statusDefs[statusKey] && statusDefs[statusKey].label) {
    return statusDefs[statusKey].label;
  }
  if (STATUS_LABELS[statusKey]) return STATUS_LABELS[statusKey];
  return statusKey;
}

/**
 * Get or create the "Cannamatrix Gantt — Status" Google Doc.
 * Stores the doc ID in script properties for reuse.
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
function syncCalendar_() {
  var cal = getOrCreateCalendar_();

  // Fetch data from Firebase
  var tasks   = fetchJson_(FIREBASE_BASE + '/tasks.json') || {};
  var sprints = fetchJson_(FIREBASE_BASE + '/sprints.json') || {};

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
  var taskKeys = Object.keys(tasks);
  for (var ti = 0; ti < taskKeys.length; ti++) {
    var key = taskKeys[ti];
    var t = tasks[key];
    if (!t.start || !t.end) continue;

    var tag = 't_' + key;
    seen[tag] = true;

    var title = '[' + (t.wbs || '?') + '] ' + (t.name || '');
    var status = STATUS_LABELS[t.status] || t.status || '';
    var body = 'Status: ' + status +
      '\nAssigned: ' + (t.assigned || '') +
      '\nProgress: ' + (t.progress != null ? t.progress + '%' : '') +
      '\n\n[firebase:' + tag + ']';
    var color = STATUS_COLORS[status] || CalendarApp.EventColor.PALE_BLUE;

    var startDate = new Date(t.start);
    var endDate   = new Date(t.end);
    endDate.setDate(endDate.getDate() + 1); // exclusive end

    var ev = eventMap[tag];
    if (ev) {
      if (ev.getTitle() !== title) ev.setTitle(title);
      if (ev.getDescription() !== body) ev.setDescription(body);
      ev.setAllDayDates(startDate, endDate);
      ev.setColor(color);
    } else {
      ev = cal.createAllDayEvent(title, startDate, endDate, { description: body });
      ev.setColor(color);
    }
  }

  // ── Sync sprints ──
  var sprintKeys = Object.keys(sprints);
  for (var si = 0; si < sprintKeys.length; si++) {
    var sKey = sprintKeys[si];
    var s = sprints[sKey];
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
 * Stores the calendar ID in script properties for reuse.
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
