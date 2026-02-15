#!/usr/bin/env bash
# sync-gantt.sh — Update gantt-data.json from memory/projects/clawdaddy.md
# Conservative: only updates status fields it can confidently parse.
# Idempotent: no commit if nothing changed.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
JSON_FILE="$REPO_DIR/gantt-data.json"
PROJECT_FILE="/home/ubuntu/clawd/memory/projects/clawdaddy.md"

if [ ! -f "$PROJECT_FILE" ]; then
  echo "Project file not found: $PROJECT_FILE"
  exit 1
fi

if [ ! -f "$JSON_FILE" ]; then
  echo "Gantt data not found: $JSON_FILE"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "jq is required but not installed"
  exit 1
fi

# Read project file content
PROJECT_CONTENT="$(cat "$PROJECT_FILE")"

# Build a temp file with updates
TEMP_JSON=$(mktemp)
cp "$JSON_FILE" "$TEMP_JSON"

# Update lastUpdated timestamp
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
jq --arg ts "$TIMESTAMP" '.meta.lastUpdated = $ts' "$TEMP_JSON" > "${TEMP_JSON}.new" && mv "${TEMP_JSON}.new" "$TEMP_JSON"

# Parse task statuses from project file
# Looks for patterns like: ✅ Task Name, 🔄 Task Name, ⏳ Task Name, 🔴 Task Name
# Or: - [x] Task Name (done), - [ ] Task Name (not started)
# Maps to gantt-data.json task IDs by matching task names

update_status() {
  local task_id="$1"
  local new_status="$2"
  jq --arg id "$task_id" --arg status "$new_status" '
    .groups |= map(.tasks |= map(
      if .id == $id then .status = $status else . end
    ))
  ' "$TEMP_JSON" > "${TEMP_JSON}.new" && mv "${TEMP_JSON}.new" "$TEMP_JSON"
}

# Extract all task IDs and names from the JSON for matching
TASK_MAP=$(jq -r '.groups[].tasks[] | "\(.id)\t\(.name)"' "$JSON_FILE")

# Look for status indicators in project file and update accordingly
while IFS=$'\t' read -r task_id task_name; do
  # Escape special regex chars in task name for grep
  escaped_name=$(echo "$task_name" | sed 's/[.[\*^$()+?{|\\]/\\&/g' | sed 's/🔴 //g')
  
  # Check for done markers: ✅, [x], "done", "complete"
  if echo "$PROJECT_CONTENT" | grep -qi "✅.*${escaped_name}\|${escaped_name}.*✅\|${escaped_name}.*done\|${escaped_name}.*complete\|\[x\].*${escaped_name}"; then
    current_status=$(jq -r --arg id "$task_id" '.groups[].tasks[] | select(.id == $id) | .status' "$JSON_FILE")
    if [ "$current_status" != "done" ]; then
      echo "Updating $task_id: $current_status → done"
      update_status "$task_id" "done"
    fi
  fi

  # Check for in-progress markers: 🔄, "in progress", "in-progress", "wip"
  if echo "$PROJECT_CONTENT" | grep -qi "🔄.*${escaped_name}\|${escaped_name}.*in.progress\|${escaped_name}.*wip"; then
    current_status=$(jq -r --arg id "$task_id" '.groups[].tasks[] | select(.id == $id) | .status' "$JSON_FILE")
    if [ "$current_status" != "in-progress" ] && [ "$current_status" != "done" ]; then
      echo "Updating $task_id: $current_status → in-progress"
      update_status "$task_id" "in-progress"
    fi
  fi

  # Check for blocked markers: 🔴, "blocked"
  if echo "$PROJECT_CONTENT" | grep -qi "🔴.*${escaped_name}\|${escaped_name}.*blocked"; then
    current_status=$(jq -r --arg id "$task_id" '.groups[].tasks[] | select(.id == $id) | .status' "$JSON_FILE")
    if [ "$current_status" != "blocked" ] && [ "$current_status" != "done" ]; then
      echo "Updating $task_id: $current_status → blocked"
      update_status "$task_id" "blocked"
    fi
  fi
done <<< "$TASK_MAP"

# Check if anything changed (ignoring lastUpdated timestamp for comparison)
OLD_DATA=$(jq 'del(.meta.lastUpdated)' "$JSON_FILE")
NEW_DATA=$(jq 'del(.meta.lastUpdated)' "$TEMP_JSON")

if [ "$OLD_DATA" = "$NEW_DATA" ]; then
  echo "No task changes detected. Skipping commit."
  rm -f "$TEMP_JSON"
  exit 0
fi

# Copy updated file
cp "$TEMP_JSON" "$JSON_FILE"
rm -f "$TEMP_JSON"

echo "gantt-data.json updated."

# Git commit and push
cd "$REPO_DIR"
git add gantt-data.json
git commit -m "sync gantt data from project file ($(date +%Y-%m-%d))"
git push origin master

echo "Changes committed and pushed."
