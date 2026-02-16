#!/usr/bin/env python3
"""Cannamatrix Gantt Chart CLI — Firebase CRUD via REST API.

Stdlib-only. No pip installs required.
All task references use WBS (e.g., 1.2.3), not Firebase IDs.
"""

import argparse
import json
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta

FIREBASE_URL = "https://cannamatrix-gantt-default-rtdb.firebaseio.com"


# ── Firebase helpers ──────────────────────────────────────────────────

def _req(path, method="GET", data=None):
    """Make a Firebase REST API request. Returns parsed JSON or None."""
    url = f"{FIREBASE_URL}/{path}.json"
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"Error {e.code}: {body}", file=sys.stderr)
        sys.exit(1)


def _get_all_tasks():
    """Return list of task dicts sorted by WBS."""
    data = _req("tasks")
    if not data:
        return []
    tasks = list(data.values())
    tasks.sort(key=lambda t: _wbs_sort_key(t.get("wbs", "")))
    return tasks


def _get_task_by_wbs(wbs):
    """Find a task by WBS. Returns (firebase_id, task_dict) or exits."""
    data = _req("tasks")
    if data:
        for fid, t in data.items():
            if t.get("wbs") == wbs:
                return fid, t
    print(f"Error: No task with WBS '{wbs}'", file=sys.stderr)
    sys.exit(1)


def _wbs_to_id(wbs):
    """Convert WBS like '1.2.3' to Firebase ID like 't1_2_3'."""
    return "t" + wbs.replace(".", "_")


def _wbs_sort_key(wbs):
    """Sort key for numeric WBS comparison."""
    try:
        return [int(x) for x in wbs.split(".")]
    except (ValueError, AttributeError):
        return [999]


def _compute_duration(start, end):
    """Days between two YYYY-MM-DD dates (inclusive of start day)."""
    try:
        s = datetime.strptime(start, "%Y-%m-%d")
        e = datetime.strptime(end, "%Y-%m-%d")
        return max((e - s).days, 1)
    except (ValueError, TypeError):
        return 0


def _add_days(start, days):
    """Add N days to a YYYY-MM-DD date string."""
    s = datetime.strptime(start, "%Y-%m-%d")
    return (s + timedelta(days=days)).strftime("%Y-%m-%d")


def _resolve_dep_wbs_to_ids(dep_wbs_list, all_tasks_data):
    """Convert list of WBS strings to Firebase task IDs."""
    wbs_to_id = {}
    if all_tasks_data:
        for fid, t in all_tasks_data.items():
            wbs_to_id[t.get("wbs")] = fid
    ids = []
    for w in dep_wbs_list:
        w = w.strip()
        if w in wbs_to_id:
            ids.append(wbs_to_id[w])
        else:
            print(f"Warning: Dependency WBS '{w}' not found, skipping", file=sys.stderr)
    return ids


def _resolve_dep_ids_to_wbs(dep_ids, all_tasks_data):
    """Convert list of Firebase IDs to WBS strings."""
    id_to_wbs = {}
    if all_tasks_data:
        for fid, t in all_tasks_data.items():
            id_to_wbs[fid] = t.get("wbs", fid)
    return [id_to_wbs.get(d, d) for d in (dep_ids or [])]


def _next_child_wbs(parent_wbs, all_tasks):
    """Find the next available child WBS under a parent."""
    prefix = parent_wbs + "."
    max_num = 0
    for t in all_tasks:
        wbs = t.get("wbs", "")
        if wbs.startswith(prefix):
            rest = wbs[len(prefix):]
            if "." not in rest:
                try:
                    num = int(rest)
                    max_num = max(max_num, num)
                except ValueError:
                    pass
    return f"{parent_wbs}.{max_num + 1}"


def _next_top_wbs(all_tasks):
    """Find the next available top-level WBS."""
    max_num = 0
    for t in all_tasks:
        wbs = t.get("wbs", "")
        if "." not in wbs:
            try:
                num = int(wbs)
                max_num = max(max_num, num)
            except ValueError:
                pass
    return str(max_num + 1)


# ── Status helpers ────────────────────────────────────────────────────

DEFAULT_STATUSES = {
    "": {"label": "-", "color": ""},
    "not_started": {"label": "Not Started", "color": "#9e9e9e"},
    "to_do": {"label": "To Do", "color": "#78909c"},
    "in_progress": {"label": "In Progress", "color": "#1a73e8"},
    "complete": {"label": "Complete", "color": "#34a853"},
    "on_hold": {"label": "On Hold", "color": "#ff9800"},
    "at_risk": {"label": "At Risk", "color": "#ea4335"},
    "blocked": {"label": "Blocked", "color": "#9c27b0"},
    "unapproved": {"label": "Unapproved/TBD", "color": "#b0bec5"},
}


def _get_statuses():
    """Fetch statuses from Firebase settings, fall back to defaults."""
    settings = _req("settings/statuses")
    if settings:
        return settings
    return DEFAULT_STATUSES


def _status_label(key, statuses=None):
    """Return display label for a status key."""
    if statuses is None:
        statuses = DEFAULT_STATUSES
    s = statuses.get(key)
    if s:
        return s.get("label", key)
    return key or "-"


# ── Output formatting ─────────────────────────────────────────────────

def _pad(s, width):
    """Left-align string in field, truncating if needed."""
    s = str(s)
    if len(s) > width:
        return s[: width - 1] + "\u2026"
    return s.ljust(width)


# ── Subcommands ───────────────────────────────────────────────────────

def cmd_list(args):
    tasks = _get_all_tasks()
    if not tasks:
        print("No tasks found.")
        return
    statuses = _get_statuses()

    # Header
    print(f"{'WBS':<10} {'Name':<52} {'Status':<16} {'Assigned':<14} {'Start':<12} {'End':<12}")
    print("-" * 116)

    for t in tasks:
        wbs = t.get("wbs", "")
        level = wbs.count(".") + 1
        indent = "  " * (level - 1)
        name = indent + t.get("name", "")
        status = _status_label(t.get("status", ""), statuses)
        assigned = t.get("assigned", "") or ""
        start = t.get("start", "")
        end = t.get("end", "")
        print(f"{_pad(wbs, 10)} {_pad(name, 52)} {_pad(status, 16)} {_pad(assigned, 14)} {_pad(start, 12)} {_pad(end, 12)}")

    # Summary
    total = len(tasks)
    complete = sum(1 for t in tasks if t.get("status") == "complete")
    in_progress = sum(1 for t in tasks if t.get("status") == "in_progress")
    print(f"\n{total} tasks | {complete} complete | {in_progress} in progress")


def cmd_get(args):
    fid, task = _get_task_by_wbs(args.wbs)
    all_data = _req("tasks")
    dep_wbs = _resolve_dep_ids_to_wbs(task.get("dependencies", []), all_data)
    statuses = _get_statuses()

    out = {
        "firebase_id": fid,
        "wbs": task.get("wbs"),
        "name": task.get("name"),
        "level": task.get("level"),
        "status_key": task.get("status", ""),
        "status_label": _status_label(task.get("status", ""), statuses),
        "start": task.get("start"),
        "end": task.get("end"),
        "duration": _compute_duration(task.get("start"), task.get("end")),
        "assigned": task.get("assigned", ""),
        "dependencies": dep_wbs,
        "notes": task.get("notes", ""),
        "autoRollup": task.get("autoRollup", False),
        "collapsed": task.get("collapsed", False),
    }
    print(json.dumps(out, indent=2))


def cmd_add(args):
    all_tasks = _get_all_tasks()

    # Determine WBS
    if args.parent:
        # Verify parent exists
        _get_task_by_wbs(args.parent)
        wbs = _next_child_wbs(args.parent, all_tasks)
    else:
        wbs = _next_top_wbs(all_tasks)

    fid = _wbs_to_id(wbs)
    level = wbs.count(".") + 1

    # Dates
    start = args.start or datetime.now().strftime("%Y-%m-%d")
    if args.end:
        end = args.end
    elif args.days:
        end = _add_days(start, int(args.days))
    else:
        end = start

    duration = _compute_duration(start, end)

    # Dependencies
    deps = []
    if args.deps:
        all_data = _req("tasks")
        dep_wbs_list = [d.strip() for d in args.deps.split(",")]
        deps = _resolve_dep_wbs_to_ids(dep_wbs_list, all_data)

    task = {
        "id": fid,
        "wbs": wbs,
        "name": args.name,
        "level": level,
        "status": args.status or "",
        "start": start,
        "end": end,
        "duration": duration,
        "assigned": args.assigned or "",
        "dependencies": deps,
        "notes": args.notes or "",
        "collapsed": False,
        "autoRollup": False,
    }

    _req(f"tasks/{fid}", method="PUT", data=task)
    print(f"Created task {wbs}: {args.name}")
    print(json.dumps(task, indent=2))


def cmd_update(args):
    fid, task = _get_task_by_wbs(args.wbs)
    updates = {}

    if args.name is not None:
        updates["name"] = args.name
    if args.status is not None:
        updates["status"] = args.status
    if args.assigned is not None:
        updates["assigned"] = args.assigned
    if args.start is not None:
        updates["start"] = args.start
    if args.end is not None:
        updates["end"] = args.end
    if args.notes is not None:
        updates["notes"] = args.notes

    # Handle --days with existing or new start
    if args.days is not None:
        start = updates.get("start") or task.get("start")
        if start:
            updates["end"] = _add_days(start, int(args.days))

    # Recalculate duration if dates changed
    new_start = updates.get("start", task.get("start"))
    new_end = updates.get("end", task.get("end"))
    if new_start and new_end and ("start" in updates or "end" in updates):
        updates["duration"] = _compute_duration(new_start, new_end)

    # Dependencies
    if args.deps is not None:
        all_data = _req("tasks")
        if args.deps == "":
            updates["dependencies"] = []
        else:
            dep_wbs_list = [d.strip() for d in args.deps.split(",")]
            updates["dependencies"] = _resolve_dep_wbs_to_ids(dep_wbs_list, all_data)

    if not updates:
        print("No fields to update.")
        return

    _req(f"tasks/{fid}", method="PATCH", data=updates)
    print(f"Updated task {args.wbs}")
    # Show updated state
    _, updated = _get_task_by_wbs(args.wbs)
    print(json.dumps(updated, indent=2))


def cmd_delete(args):
    fid, task = _get_task_by_wbs(args.wbs)
    all_tasks = _get_all_tasks()

    # Find children (WBS starts with this WBS + ".")
    to_delete = [(fid, args.wbs)]
    prefix = args.wbs + "."
    all_data = _req("tasks")
    if all_data:
        for child_fid, child in all_data.items():
            if child.get("wbs", "").startswith(prefix):
                to_delete.append((child_fid, child["wbs"]))

    for del_fid, del_wbs in to_delete:
        _req(f"tasks/{del_fid}", method="DELETE")
        print(f"Deleted {del_wbs}")

    print(f"Deleted {len(to_delete)} task(s)")


def cmd_move(args):
    fid, task = _get_task_by_wbs(args.wbs)
    all_tasks = _get_all_tasks()
    all_data = _req("tasks")

    old_wbs = args.wbs
    old_prefix = old_wbs + "."

    # Collect this task + children
    to_move = [(fid, task)]
    if all_data:
        for child_fid, child in all_data.items():
            if child.get("wbs", "").startswith(old_prefix):
                to_move.append((child_fid, child))

    # Sort by WBS depth so parent is first
    to_move.sort(key=lambda x: _wbs_sort_key(x[1].get("wbs", "")))

    # Calculate new WBS for the root task
    if args.under:
        _get_task_by_wbs(args.under)
        new_root_wbs = _next_child_wbs(args.under, all_tasks)
    else:
        new_root_wbs = _next_top_wbs(all_tasks)

    # Build WBS mapping
    wbs_map = {}
    for move_fid, move_task in to_move:
        old_w = move_task["wbs"]
        if old_w == old_wbs:
            new_w = new_root_wbs
        else:
            suffix = old_w[len(old_prefix):]
            new_w = new_root_wbs + "." + suffix
        wbs_map[old_w] = new_w

    # Delete old, write new
    for move_fid, move_task in to_move:
        _req(f"tasks/{move_fid}", method="DELETE")

    for move_fid, move_task in to_move:
        old_w = move_task["wbs"]
        new_w = wbs_map[old_w]
        new_fid = _wbs_to_id(new_w)
        move_task["wbs"] = new_w
        move_task["id"] = new_fid
        move_task["level"] = new_w.count(".") + 1
        _req(f"tasks/{new_fid}", method="PUT", data=move_task)
        print(f"  {old_w} -> {new_w}  {move_task.get('name', '')}")

    print(f"Moved {len(to_move)} task(s)")


def cmd_add_dep(args):
    fid, task = _get_task_by_wbs(args.wbs)
    all_data = _req("tasks")
    dep_fid_map = {}
    if all_data:
        for k, v in all_data.items():
            dep_fid_map[v.get("wbs")] = k

    dep_id = dep_fid_map.get(args.on)
    if not dep_id:
        print(f"Error: Dependency WBS '{args.on}' not found", file=sys.stderr)
        sys.exit(1)

    deps = task.get("dependencies", []) or []
    if dep_id not in deps:
        deps.append(dep_id)
        _req(f"tasks/{fid}", method="PATCH", data={"dependencies": deps})
        print(f"Added dependency: {args.wbs} depends on {args.on}")
    else:
        print(f"Dependency already exists: {args.wbs} depends on {args.on}")


def cmd_rm_dep(args):
    fid, task = _get_task_by_wbs(args.wbs)
    all_data = _req("tasks")
    dep_fid_map = {}
    if all_data:
        for k, v in all_data.items():
            dep_fid_map[v.get("wbs")] = k

    dep_id = dep_fid_map.get(args.on)
    if not dep_id:
        print(f"Error: Dependency WBS '{args.on}' not found", file=sys.stderr)
        sys.exit(1)

    deps = task.get("dependencies", []) or []
    if dep_id in deps:
        deps.remove(dep_id)
        _req(f"tasks/{fid}", method="PATCH", data={"dependencies": deps})
        print(f"Removed dependency: {args.wbs} no longer depends on {args.on}")
    else:
        print(f"No such dependency: {args.wbs} does not depend on {args.on}")


def cmd_bulk_status(args):
    wbs_list = [w.strip() for w in args.wbs_list.split(",")]
    status = args.status
    for wbs in wbs_list:
        fid, task = _get_task_by_wbs(wbs)
        _req(f"tasks/{fid}", method="PATCH", data={"status": status})
        print(f"Set {wbs} -> {status}")
    print(f"Updated {len(wbs_list)} task(s)")


def cmd_statuses(args):
    statuses = _get_statuses()
    print(f"{'Key':<16} {'Label':<20} {'Color':<10}")
    print("-" * 46)
    for key in ["", "not_started", "to_do", "in_progress", "complete", "on_hold", "at_risk", "blocked", "unapproved"]:
        s = statuses.get(key, {})
        label = s.get("label", key or "-")
        color = s.get("color", "")
        display_key = key if key else "(empty)"
        print(f"{display_key:<16} {label:<20} {color:<10}")


def cmd_team(args):
    team = _req("team")
    if not team:
        print("No team data found.")
        return
    if isinstance(team, list):
        members = [m for m in team if m]
    elif isinstance(team, dict):
        members = list(team.values())
    else:
        members = []
    print("Team members:")
    for m in members:
        print(f"  - {m}")


def cmd_sprints(args):
    sprints = _req("sprints")
    if not sprints:
        print("No sprints found.")
        return
    sprint_list = []
    for sid, s in sprints.items():
        s["_id"] = sid
        sprint_list.append(s)
    sprint_list.sort(key=lambda s: s.get("start", ""))

    print(f"{'Name':<34} {'Start':<14} {'End':<14} {'Color':<10}")
    print("-" * 72)
    for s in sprint_list:
        print(f"{_pad(s.get('name', ''), 34)} {_pad(s.get('start', ''), 14)} {_pad(s.get('end', ''), 14)} {_pad(s.get('color', ''), 10)}")


# ── Main ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Cannamatrix Gantt Chart CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # list
    sub.add_parser("list", help="List all tasks")

    # get
    p = sub.add_parser("get", help="Get full task details (JSON)")
    p.add_argument("wbs", help="Task WBS (e.g., 1.2.3)")

    # add
    p = sub.add_parser("add", help="Add a new task")
    p.add_argument("--name", required=True, help="Task name")
    p.add_argument("--parent", help="Parent WBS (omit for top-level)")
    p.add_argument("--assigned", help="Assignee name(s)")
    p.add_argument("--start", help="Start date (YYYY-MM-DD)")
    p.add_argument("--end", help="End date (YYYY-MM-DD)")
    p.add_argument("--days", help="Duration in days (alternative to --end)")
    p.add_argument("--status", help="Status key")
    p.add_argument("--deps", help="Comma-separated dependency WBS list")
    p.add_argument("--notes", help="Notes")

    # update
    p = sub.add_parser("update", help="Update task fields")
    p.add_argument("wbs", help="Task WBS to update")
    p.add_argument("--name", help="New name")
    p.add_argument("--assigned", help="New assignee")
    p.add_argument("--start", help="New start date")
    p.add_argument("--end", help="New end date")
    p.add_argument("--days", help="Duration in days (recalculates end)")
    p.add_argument("--status", help="New status key")
    p.add_argument("--deps", help="Replace dependencies (comma-sep WBS, empty to clear)")
    p.add_argument("--notes", help="New notes")

    # delete
    p = sub.add_parser("delete", help="Delete task and children")
    p.add_argument("wbs", help="Task WBS to delete")

    # move
    p = sub.add_parser("move", help="Re-parent a task")
    p.add_argument("wbs", help="Task WBS to move")
    p.add_argument("--under", help="New parent WBS (omit for top-level)")

    # add-dep
    p = sub.add_parser("add-dep", help="Add a dependency")
    p.add_argument("wbs", help="Task WBS")
    p.add_argument("--on", required=True, help="Depends-on WBS")

    # rm-dep
    p = sub.add_parser("rm-dep", help="Remove a dependency")
    p.add_argument("wbs", help="Task WBS")
    p.add_argument("--on", required=True, help="Dependency to remove (WBS)")

    # bulk-status
    p = sub.add_parser("bulk-status", help="Set status on multiple tasks")
    p.add_argument("wbs_list", help="Comma-separated WBS list")
    p.add_argument("--status", required=True, help="Status key to set")

    # statuses
    sub.add_parser("statuses", help="List available statuses")

    # team
    sub.add_parser("team", help="List team members")

    # sprints
    sub.add_parser("sprints", help="List sprints")

    args = parser.parse_args()
    cmd_map = {
        "list": cmd_list,
        "get": cmd_get,
        "add": cmd_add,
        "update": cmd_update,
        "delete": cmd_delete,
        "move": cmd_move,
        "add-dep": cmd_add_dep,
        "rm-dep": cmd_rm_dep,
        "bulk-status": cmd_bulk_status,
        "statuses": cmd_statuses,
        "team": cmd_team,
        "sprints": cmd_sprints,
    }
    cmd_map[args.command](args)


if __name__ == "__main__":
    main()
