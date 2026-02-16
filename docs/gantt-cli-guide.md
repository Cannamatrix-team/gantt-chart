# Gantt Chart CLI Reference

Command-line interface for managing the Cannamatrix Gantt Chart via Firebase Realtime Database.

**CLI path:** `python3 ~/projects/gantt-chart/gantt-cli.py`
**Firebase:** `https://cannamatrix-gantt-default-rtdb.firebaseio.com`
**No dependencies** — stdlib Python only (urllib, json, argparse).

---

## Commands

### `list` — Show all tasks

```bash
python3 gantt-cli.py list
```

Output columns: WBS, Name (indented by level), Status, Assigned, Start, End.
Includes summary line: total tasks, complete count, in-progress count.

### `get <wbs>` — Task details (JSON)

```bash
python3 gantt-cli.py get 4.5
```

Returns full JSON: firebase_id, wbs, name, level, status_key, status_label, start, end, duration, assigned, dependencies (as WBS list), notes, autoRollup, collapsed.

### `add` — Create a task

```bash
python3 gantt-cli.py add --name "Run GLIMPSE" --parent 1.2 --assigned "Kevelin" \
  --start 2026-02-20 --days 3 --status to_do --deps "1.1,1.3" --notes "Imputation step"
```

| Flag | Required | Description |
|------|----------|-------------|
| `--name` | Yes | Task name |
| `--parent` | No | Parent WBS. Omit for new top-level task |
| `--assigned` | No | Assignee name(s), comma-separated |
| `--start` | No | Start date (YYYY-MM-DD). Defaults to today |
| `--end` | No | End date (YYYY-MM-DD) |
| `--days` | No | Duration in days (alternative to --end, computes end from start) |
| `--status` | No | Status key (see Status Keys below) |
| `--deps` | No | Comma-separated WBS of dependencies |
| `--notes` | No | Free-text notes |

Auto-calculates: WBS (next available sibling/child), level, duration, Firebase ID.

### `update <wbs>` — Update task fields

```bash
python3 gantt-cli.py update 4.9 --status complete --assigned "Logan"
python3 gantt-cli.py update 6.1 --end 2026-02-14 --notes "Extended timeline"
```

Same flags as `add` (all optional). Only specified fields are updated.
`--days` recalculates end date from start.
`--deps ""` (empty string) clears all dependencies.

### `delete <wbs>` — Delete task and children

```bash
python3 gantt-cli.py delete 4.10
```

Deletes the task and all subtasks (children with WBS prefix match).

### `move <wbs> --under <parent-wbs>` — Re-parent a task

```bash
python3 gantt-cli.py move 4.10 --under 6
```

Moves a task (and its children) under a new parent. Recalculates WBS, level, and Firebase IDs.
Omit `--under` to make it a new top-level task.

### `add-dep <wbs> --on <dep-wbs>` — Add dependency

```bash
python3 gantt-cli.py add-dep 1.2 --on 1.1
```

Means: task 1.2 depends on (cannot start until) task 1.1 completes.

### `rm-dep <wbs> --on <dep-wbs>` — Remove dependency

```bash
python3 gantt-cli.py rm-dep 1.2 --on 1.1
```

### `bulk-status <wbs,wbs,...> --status <key>` — Bulk status update

```bash
python3 gantt-cli.py bulk-status "6.1,6.2,6.3" --status in_progress
```

### `statuses` — List status options

```bash
python3 gantt-cli.py statuses
```

### `team` — List team members

```bash
python3 gantt-cli.py team
```

### `sprints` — List sprints

```bash
python3 gantt-cli.py sprints
```

---

## Status Keys

| Key | Label | Color |
|-----|-------|-------|
| *(empty string)* | - | |
| `not_started` | Not Started | #9e9e9e |
| `to_do` | To Do | #78909c |
| `in_progress` | In Progress | #1a73e8 |
| `complete` | Complete | #34a853 |
| `on_hold` | On Hold | #ff9800 |
| `at_risk` | At Risk | #ea4335 |
| `blocked` | Blocked | #9c27b0 |
| `unapproved` | Unapproved/TBD | #b0bec5 |

---

## Firebase Data Schema

### Task Object

```json
{
  "id": "t1_2_3",
  "wbs": "1.2.3",
  "name": "Task name",
  "level": 3,
  "status": "in_progress",
  "start": "2026-02-10",
  "end": "2026-02-14",
  "duration": 4,
  "assigned": "Kevelin",
  "dependencies": ["t1_1", "t1_3"],
  "notes": "Free text",
  "collapsed": false,
  "autoRollup": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Firebase key, derived from WBS: `t` + WBS with dots→underscores |
| `wbs` | string | Work Breakdown Structure (e.g., `1.2.3`). Numeric dot notation |
| `name` | string | Task title |
| `level` | number | WBS depth (1 = top-level, 2 = subtask, etc.) |
| `status` | string | Status key (see table above). Empty string = unset |
| `start` | string | Start date, `YYYY-MM-DD` |
| `end` | string | End date, `YYYY-MM-DD` |
| `duration` | number | Days between start and end |
| `assigned` | string | Assignee name(s). Comma-separated for multiple |
| `dependencies` | array | Firebase IDs of prerequisite tasks |
| `notes` | string | Free-text notes |
| `collapsed` | boolean | UI state (children collapsed in chart view) |
| `autoRollup` | boolean | Auto-compute parent dates from children |

### WBS Conventions

- Numeric levels separated by periods: `1`, `1.1`, `1.1.1`
- Sorted numerically: `1.2` before `1.10`
- Level = number of components: WBS `1.2.3` = level 3
- Firebase ID = `t` + WBS with `.` replaced by `_`: WBS `4.10.1` → ID `t4_10_1`

### Sprint Object

```json
{
  "name": "Sprint 8",
  "start": "2026-02-09",
  "end": "2026-02-20",
  "color": "#34a853"
}
```

### Team

Array of name strings: `["Logan", "Manny", "Kevelin"]`

---

## Natural Language → CLI Translation Examples

| Natural language | CLI command |
|-----------------|-------------|
| "Show me all tasks" | `list` |
| "What's the status of task 4.9?" | `get 4.9` |
| "Add a 3-day task under 1.2 for Kevelin called Run GLIMPSE starting Feb 20" | `add --name "Run GLIMPSE" --parent 1.2 --assigned "Kevelin" --start 2026-02-20 --days 3` |
| "Mark 1.3 as complete" | `update 1.3 --status complete` |
| "Assign Kevelin to task 6.1" | `update 6.1 --assigned "Kevelin"` |
| "Push 4.9 end date to Feb 14" | `update 4.9 --end 2026-02-14` |
| "Delete section 4.10 and its subtasks" | `delete 4.10` |
| "Move task 4.10 under section 6" | `move 4.10 --under 6` |
| "Task 1.2 depends on 1.1" | `add-dep 1.2 --on 1.1` |
| "Remove dependency of 1.2 on 1.1" | `rm-dep 1.2 --on 1.1` |
| "Set 6.1, 6.2, 6.3 to in progress" | `bulk-status "6.1,6.2,6.3" --status in_progress` |
| "What statuses are available?" | `statuses` |
| "Who's on the team?" | `team` |
| "What are the sprints?" | `sprints` |

---

## Architecture Notes

- **Firebase REST API**: All operations use `urllib` HTTP requests to `{FIREBASE_URL}/{path}.json`
- **No authentication required**: Firebase rules allow public read/write for this project database
- **Real-time sync**: Changes appear immediately in the web-based gantt chart (index.html)
- **Google Sheets sync**: An Apps Script timer syncs Firebase → Google Sheets every 5 minutes
- **Google Calendar sync**: Same Apps Script also syncs tasks/sprints to a Google Calendar
