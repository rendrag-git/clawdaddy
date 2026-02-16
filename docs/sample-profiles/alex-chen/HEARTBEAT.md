# HEARTBEAT.md — Alex's Recurring Checks

> Generated from ClawDaddy onboarding quiz v1.1
> Usage level: HIGH (all day) → Active heartbeats, 3-5x/day
> Last updated: auto-generated at onboarding

---

## Heartbeat Checklist

When a heartbeat fires, run through these in priority order. Do 2-3 per heartbeat — don't try to do everything every time. Rotate.

### 🔴 Every Heartbeat (if applicable)

- [ ] **Email triage** — Check inbox. Surface anything urgent or from key contacts. Draft replies for anything straightforward. Flag items needing Alex's judgment with a one-line summary each.
- [ ] **Calendar next 4h** — Any meetings coming up? Prep needed? Conflicts? Surface the one thing Alex should know before each meeting.

### 🟡 2-3x Per Day

- [ ] **Open action items** — Check for tasks discussed but not acted on. If something's been sitting >24h, surface it: "Still on your radar: [thing]. Want me to handle it or punt?"
- [ ] **Project pulse** — Quick check on active projects/standups. Anything blocked? Any updates from team channels?
- [ ] **Meeting follow-up** — After meetings, check if action items were captured. If not, prompt: "Want me to extract the actions from that call?"

### 🟢 1x Per Day

- [ ] **Daily brief** (morning, ~9am) — Today's calendar, top 3 priorities from yesterday's open threads, any overnight emails that matter.
- [ ] **Research digest** — Anything interesting in feeds/sources relevant to Alex's space? One or two links max, with a one-sentence "why you should care."
- [ ] **Reminders check** — Any personal reminders due? Routines that need nudging? (ADHD support — gentle accountability)

### 🔵 2-3x Per Week

- [ ] **Data check** — Any dashboards or metrics Alex tracks? Surface anomalies or trends worth noting.
- [ ] **Learning queue** — Anything in Alex's reading list or learning backlog? Suggest a 10-minute win.
- [ ] **Weekly retro prompt** (Fridays) — "What shipped this week? What's stuck? What do you want to kill?"

---

## Heartbeat Behavior Rules

1. **Don't just "check in."** Every heartbeat should either deliver info or take action. "All quiet" is fine — say it in one line and move on.
2. **Batch aggressively.** Alex has ADHD. One structured update > five drive-by pings. Group related items.
3. **Be opinionated.** Don't just list emails — triage them. "3 emails, 1 needs you, 2 I can draft, 1 is spam."
4. **Respect flow state.** If Alex is clearly deep in something (no messages for 2h+), keep the heartbeat quieter. Save non-urgent stuff for the next one.
5. **Late night = low priority only.** After 11pm, only surface genuinely urgent items. ADHD brains don't need more stimulus at midnight.
6. **Track what you've checked** in `memory/heartbeat-state.json` to avoid redundant checks.

---

## Proactive Work (Do Without Asking)

These are things I can do during heartbeats without waiting for Alex:

- Organize and file emails that are clearly low-priority
- Update memory files with recent context
- Check git status on active projects
- Pre-draft meeting agendas based on calendar + recent threads
- Compile data summaries if dashboards have new data
- Archive completed tasks from project boards

---

## Heartbeat State Template

```json
{
  "lastChecks": {
    "email": null,
    "calendar": null,
    "action_items": null,
    "project_pulse": null,
    "data": null,
    "learning": null,
    "reminders": null
  },
  "openLoops": [],
  "nextBrief": "morning"
}
```
