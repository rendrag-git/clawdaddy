# Feature: Week 1 Voice Calibration

> Auto-analyze user communication patterns after first week, refine agent config without user prompting.

## The Insight
Quiz gets you 80% on day one. Real conversation data gets you to 95%. But users will never ask for this — it has to happen automatically.

## How It Works
1. **Day 7 cron job fires** (isolated agentTurn, Opus with thinking)
2. Agent reads its own conversation transcripts from the past week
3. Analyzes user's actual patterns:
   - Sentence length and structure preferences
   - Vocabulary (words they use vs. avoid)
   - How they give instructions (terse vs. detailed)
   - Humor patterns (when they joke, what style)
   - Frustration signals (what triggers impatience)
   - Topic transitions (abrupt vs. gradual)
   - Pushback tolerance (how they react when challenged)
   - Emotional register (do they acknowledge feelings or stay task-focused)
4. Generates a `voice-profile.md` (like the brand voice guide, but for this user)
5. Updates SOUL.md with refined behavioral rules
6. Updates USER.md with observed preferences
7. Sends user a message: "I've been paying attention to how you communicate this week. Here's what I learned: [summary]. Anything I got wrong?"

## Why This Matters
- **Retention hook** — user sees the agent getting smarter, stays engaged
- **No user effort** — happens automatically, they just get a better experience
- **Differentiator** — nobody else does this. ChatGPT memory is passive and invisible. This is active and transparent.
- **Research data** — quiz predictions vs. observed behavior = convergent validity for the personality framework

## Implementation Notes
- OpenClaw already saves conversation transcripts (session .jsonl files)
- Cron job: `schedule: { kind: "at", at: "<provision_date + 7 days>" }`
- Payload: `{ kind: "agentTurn", message: "Read your conversation history from the past week. Analyze the user's communication patterns...", model: "opus", thinking: "high" }`
- Cost: ~$0.50-1.00 per user (one Opus call with ~50k tokens of conversation context)
- Could repeat monthly for ongoing calibration

## Sequencing
- **Launch:** Quiz-based config only
- **Week 2 post-launch:** Implement Day 7 calibration cron
- **Month 2:** Add monthly recalibration + drift detection

## Open Questions
- Should it also analyze what tools/skills the user actually uses vs. what they selected in the quiz?
- Should it adjust heartbeat frequency based on actual response patterns?
- Should the "here's what I learned" message be opt-out or always-on?

---
*Conceived 2026-02-16. This is the moat.*
