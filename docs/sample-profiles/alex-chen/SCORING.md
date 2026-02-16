# SCORING.md — Quiz Results & Scoring Breakdown

> Full pipeline trace for Alex Chen's onboarding quiz
> Generated from ClawDaddy quiz v1.1

---

## Quiz Answers

| Q | Prompt (abbreviated) | Answer | Key Traits Hit |
|---|---|---|---|
| A1 | 37 tabs, surprise meeting | (c) Message someone, roll in confident | collaborative, reactive, big_picture, casual |
| A2 | New gadget, no wizard | (b) Press buttons until it works | spontaneous, playful, independent, big_picture |
| A3 | Museum vs food alley | (c) Do both — time is a suggestion | organized, spontaneous, proactive, big_picture |
| A4 | "Quick question" at 4:59pm | (b) One-liner + tomorrow if bigger | organized, formal, proactive, big_picture |
| A5 | Assistant movie vibe | (c) Witty sidekick, occasionally unhinged | playful, casual, proactive, big_picture |
| A6 | Suboptimal decision | (a) Push back with evidence | proactive, serious, detailed, independent |
| A7 | Dinner cooking style | (d) Optimize: main + easy sides + backup | organized, big_picture, proactive |
| A8 | How to update you | (c) Only if blocked or decision needed | independent, big_picture, proactive |
| A9 | Starting something new | (b) Scrappy prototype immediately | spontaneous, proactive, independent |
| A10 | Long article | (c) Jump to conclusion, backfill if needed | big_picture, proactive, independent |
| A11 | Assistant makes a pun | (b) Occasional jokes, don't derail | playful, organized, big_picture |
| B1 | Personal help | Calendar, reminders, learning | — (tags only) |
| B2 | Professional help | Email, research, data, PM, meetings | — (tags only) |
| B3 | Usage frequency | (a) All day — second brain | proactive, collaborative, casual, organized |
| B4 | Role | Startup founder/CEO, B2B SaaS, 12-person team | — (free text) |
| B5 | Name | Alex | — (free text) |

---

## Raw Trait Pole Totals

```
organized:      2.20  ████████████
spontaneous:    2.00  ██████████
formal:         0.40  ██
casual:         1.30  ███████
proactive:      4.00  ████████████████████
reactive:       0.50  ███
detailed:       0.50  ███
big_picture:    4.30  ██████████████████████
serious:        0.40  ██
playful:        1.80  █████████
independent:    2.40  ████████████
collaborative:  1.20  ██████
```

**Dominant poles:** proactive (4.00), big_picture (4.30), independent (2.40), organized (2.20)
**Weak poles:** formal (0.40), reactive (0.50), detailed (0.50), serious (0.40)

---

## Normalized Dimension Scores (0..1)

Left-pole strength. 0.5 = perfectly balanced.

| Dimension | Score | Label | Confidence |
|---|---|---|---|
| organized vs spontaneous | 0.524 | Balanced | 1.00 |
| formal vs casual | 0.235 | **Casual** | 0.57 |
| proactive vs reactive | 0.889 | **Proactive** | 1.00 |
| detailed vs big_picture | 0.104 | **Big-picture** | 1.00 |
| serious vs playful | 0.182 | **Playful** | 0.73 |
| independent vs collaborative | 0.667 | **Mostly independent** | 1.00 |

### Extended Dimensions (derived from research framework)

| Dimension | Score | Label | Derivation |
|---|---|---|---|
| supportive vs challenging | 0.756 | **Challenging** | 0.4×autonomy + 0.4×proactivity + 0.2×(1-collab_ratio) |
| practical vs exploratory | 0.686 | **Balanced-creative** | 0.5×spontaneous_ratio + 0.5×big_picture_ratio |
| analytical vs empathetic | 0.333 | **Matter-of-fact** | 0.6×collab_ratio + 0.4×(1-autonomy) |

---

## Derived Dials

| Dial | Value | Meaning |
|---|---|---|
| casualness | 0.765 | Casual — contractions, first-person, no corporate-speak |
| humor | 0.818 | High — witty sidekick mode, dark humor welcome |
| proactivity | 0.889 | Very high — suggest, flag, anticipate needs |
| verbosity | 0.566 | Balanced — concise default, thorough when stakes are high |
| structure | 0.524 | Balanced — light structure, bullets preferred |
| autonomy | 0.667 | Moderate-high — work independently, check in at decision points |
| challenge | 0.756 | High — push back on weak reasoning, play devil's advocate |
| creativity | 0.686 | Balanced-creative — proven approach + one wild card |
| emotional_attunement | 0.333 | Low — matter-of-fact, problem-solving over emotional support |

### Verbosity Calculation
```
verbosity = 0.55 × detail(0.104) + 0.25 × structure(0.524) + 0.20 × proactivity(0.889) + usage_factor(0.20)
          = 0.057 + 0.131 + 0.178 + 0.200
          = 0.566
```

---

## Style Classifications

| Style | Value | Logic |
|---|---|---|
| **Disagreement mode** | Advisor | proactivity(0.889) > 0.62 AND autonomy(0.667) >= 0.45 → pushes back with evidence |
| **Humor style** | Witty sidekick | humor(0.818) > 0.70 AND casualness(0.765) > 0.55 |
| **Creativity style** | Balanced-creative | creativity(0.686) in [0.50, 0.70] → solid approach + creative alternative |
| **Emotional style** | Matter-of-fact | emotional_att(0.333) in [0.30, 0.45] → skip feelings, solve problems |
| **Tone label** | Casual | casualness(0.765) > 0.55 |
| **Plan style** | Light structure | structure(0.524) in [0.38, 0.62] |
| **Writing style** | Balanced | verbosity(0.566) in [0.38, 0.62] |

---

## Style Summary

> Proactive, prefers a casual tone, big-picture by default, leans playful, works best when mostly independent.

**Archetype: The Catalyst ⚡**

---

## Tags Collected

```
personal:calendar
personal:reminders
personal:learning
work:email
work:research
work:data_analysis
work:project_management
work:meetings
usage:high
```

## Free Text Fields

```
user.role:           Startup founder / CEO — B2B SaaS, 12-person team
user.preferred_name: Alex
```
