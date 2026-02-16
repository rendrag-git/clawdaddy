# Patent Viability Analysis: ClawDaddy LLC

**Prepared:** February 16, 2026  
**For:** Pearson / ClawDaddy LLC  
**Status:** Research Analysis — Not Legal Advice

---

## Executive Summary

Neither innovation is a strong patent candidate on the merits. Both face significant §101 (abstract idea) and §103 (obviousness) challenges. However, **Innovation 1 has a marginally better shot** due to its specific technical pipeline, and the $65 filing fee for a provisional makes the "patent pending" label a defensible business decision for both — especially for acquisition positioning.

**Bottom line:** File provisionals for both (~$130 total self-filed). Don't spend $5K+ on attorney-drafted applications unless you're raising money and need the optics.

---

## Innovation 1: Psychometric Quiz → AI Assistant Configuration Pipeline

### Description
Big Five-based personality quiz (9 dimensions, 12 questions) → psychometric scoring algorithm → dimension normalization → behavioral parameter derivation → system prompt template generation (SOUL.md/USER.md) → automated deployment to dedicated AI assistant instance.

### 1. Prior Art Analysis

**Direct prior art (damaging):**

- **Arxiv 2410.19238** — "Designing AI-Agents with Personalities: A Psychometric Approach" (Oct 2024). Academic paper describing *exactly* Big Five framework → AI agent personality assignment. Uses psychometric parameters to configure AI agent behavior. This is the closest prior art and it's publicly available.

- **AgentPsy (agentpsy.com)** — Commercial product for "personalized agent configuration based on rigorous personality and psychological assessments." Directly overlapping concept.

- **US20070048706A1** — Psychometric assessment tool for online personality evaluation. Older patent covering personality quiz → interpretation pipeline (pre-LLM era, but establishes the psychometric-to-output mapping concept).

- **OpenAI Custom GPTs / Custom Instructions** — Users already manually configure AI personality through text instructions. ChatGPT memory feature learns preferences over time.

- **Character.ai** — Users create AI personalities with specific behavioral parameters (tone, style, knowledge). Millions of custom characters exist.

**Big tech patents in adjacent space:**

- **Microsoft US20250310281** (Oct 2025) — "Contextualizing Chat Responses Based on Conversation History." Builds user profiles asynchronously from prior conversations to personalize responses. Filed by Microsoft. *This is very close to Innovation 2 and adjacent to Innovation 1.*

- **Microsoft (2021)** — Patent for creating chatbots that imitate specific people using social data to replicate personality. US Patent for training chat bots to "converse and interact in the personality of a specific person."

- **Microsoft (2024)** — Patent for personalizing digital assistant interactions using prior corrective responses and contextual data.

- **Apple US20120016678A1** — Siri's intelligent automated assistant patent covering short/long term memory, user profile building, and contextual adaptation.

**Academic literature:**
The concept of mapping psychometric scores to behavioral parameters is well-established in psychology and HCI research. Multiple papers exist on Big Five → chatbot behavior mapping.

### 2. Patentability Under 35 USC §101 (Alice Analysis)

**Step 1: Is this an abstract idea?**

Yes. At the highest level, this is "administering a personality test and using the results to configure a software system." That's a mental process (personality assessment) combined with a mathematical concept (scoring algorithm) applied to software configuration. Under Alice, this maps cleanly to "abstract idea."

**Step 2: Does it add "something significantly more"?**

This is where it gets interesting but probably not enough:

- The specific pipeline (quiz → scoring → normalization → parameter derivation → template generation → deployment) is a technical implementation
- The automated generation of SOUL.md/USER.md config files that deploy to a live AI instance is a concrete technical step
- The specific mapping algorithm (9 dimensions from 12 questions → normalized scores → behavioral parameters) could be argued as a technical improvement

**Comparison to cases that survived Alice:**

- **Enfish v. Microsoft (2016):** Survived because it claimed a specific improvement to computer functionality (self-referential database table). ClawDaddy's innovation doesn't improve *computer functionality* — it uses computers to do something (personality mapping). This distinction matters.
- **BASCOM v. AT&T (2016):** Survived at Step 2 because the *ordered combination* of known elements was non-conventional. You could argue the specific pipeline order is non-conventional, but this is a stretch.

**Honest assessment:** 60-70% chance of §101 rejection at USPTO. If it somehow got granted, ~50% chance of invalidation under Alice in litigation.

### 3. Patentability Under 35 USC §103 (Obviousness)

**Would a PHOSITA find this obvious?**

Probably yes. A person skilled in the art (someone who knows psychometric testing AND LLM configuration) would likely say:

1. Personality quizzes exist → well-known
2. System prompts configure LLM behavior → well-known
3. Combining them is the obvious next step

**The strongest non-obvious argument:**
The specific dimensional mapping (how Big Five scores translate to concrete system prompt parameters like humor level, challenge tolerance, emotional register) and the automated pipeline that generates deployment-ready config files. The inventive step is in the *specifics* of the mapping algorithm, not the concept.

**Honest assessment:** Weak on obviousness. The Arxiv paper (2410.19238) doing essentially the same thing academically is very damaging.

### 4. Provisional Patent Filing

**Cost:**
- Self-file (micro entity): **$65 USPTO fee**
- Attorney-assisted: **$1,500–$3,500** for provisional drafting
- Self-file with patent writing AI tool (Solve Intelligence, DeepIP): **$65 + ~$50-100/month tool subscription**

**What the provisional needs:**
- Detailed description of the pipeline (every step)
- The specific scoring algorithm and dimensional mappings
- Flowcharts/diagrams of the system architecture
- Example inputs and outputs at each stage
- Description of the SOUL.md/USER.md file format and deployment mechanism
- As many implementation details as possible (provisionals establish priority date only for what they describe)

**12-month window:**
File by Feb 2027 means you must convert to non-provisional or file PCT by Feb 2028. Non-provisional utility patent costs $8,000–$15,000+ with attorney. If you don't convert, you lose the priority date but owe nothing more.

### 5. Recommendation: **FILE PROVISIONAL (Self-File)**

**Rationale:** Not because it's a strong patent, but because:
- $65 is trivial
- "Patent Pending" on the website and pitch decks has real value
- If ClawDaddy gets acquired, the provisional is an asset in the IP portfolio
- You have 12 months to decide whether to invest in non-provisional
- Pearson has patent litigation experience and can draft a decent provisional himself
- The specific pipeline implementation details are worth documenting for priority date purposes even if the broad concept isn't patentable

**What would make it stronger:**
- Novel scoring algorithm (not standard Big Five scoring)
- Specific technical improvements to AI behavior resulting from the pipeline (measurable)
- Hardware-specific optimizations or deployment architecture innovations

---

## Innovation 2: Automatic Communication Style Calibration from Conversation History

### Description
After 1 week of conversations, an automated analysis job reads transcripts, identifies communication patterns (sentence structure, vocabulary, humor, frustration signals, pushback tolerance), and autonomously refines AI assistant configuration without user prompting.

### 1. Prior Art Analysis

**This one has MORE prior art problems than Innovation 1:**

- **Microsoft US20250310281** (Oct 2025) — "Contextualizing Chat Responses Based on Conversation History." This is *almost exactly* Innovation 2. Microsoft's patent describes: analyzing prior conversations → building user profile asynchronously → using profile to personalize future responses. Filed October 2025. **This is a potential blocking patent.**

- **Microsoft Personalization Patent (2024)** — Leveraging prior corrective responses to personalize digital assistant behavior externally to skill components. Again, very close.

- **Pi by Inflection AI** — Product description literally says it "gradually learns your preferences, moods, and interaction style, enhancing future conversations." Commercially available since 2023.

- **ChatGPT Memory (OpenAI, 2024)** — Automatically remembers user preferences and context across conversations. Adapts responses based on accumulated interaction history.

- **Replika** — AI companion that explicitly adapts communication style based on ongoing conversations. Has been doing this since ~2017.

- **Revenue.io US Patent 10,440,181** (2019) — Adaptive conversational system that monitors conversations and extracts conversation elements for adaptation.

- **Apple Siri patent (US20120016678A1)** — Covers short/long term memory for interpreting user input in context of previous interactions.

**The prior art landscape here is a minefield.** Multiple big tech companies have patents and products covering conversation-history-based AI personalization.

### 2. Patentability Under 35 USC §101 (Alice Analysis)

**Step 1: Is this an abstract idea?**

Yes, clearly. "Analyzing conversations to learn communication preferences and adapting future interactions" is a mental process that humans do naturally. Every good customer service rep does this. Automating a human mental process on a computer is the textbook Alice §101 rejection.

**Step 2: Something significantly more?**

The specific technical elements:
- Automated batch analysis job (cron-style, after 1 week)
- NLP pattern extraction (sentence structure, vocabulary analysis, frustration signal detection)
- Autonomous config file modification without user intervention
- Specific signal detection algorithms (pushback tolerance, humor classification)

These are more concrete than Innovation 1 in some ways, but the core concept is so well-tread that it's hard to argue the implementation adds "significantly more."

**Honest assessment:** 75-80% chance of §101 rejection. Microsoft's 2025 patent application covers nearly identical ground with big-tech prosecution resources behind it.

### 3. Patentability Under 35 USC §103 (Obviousness)

**Very obvious.** The combination of:
- Conversation analysis (NLP, well-known)
- User profiling from interaction history (well-known)
- Adaptive AI behavior (well-known, multiple commercial products)

A PHOSITA would absolutely find this obvious. Pi, ChatGPT Memory, and Replika all demonstrate the concept commercially.

**Possible non-obvious elements:**
- The specific "1 week batch analysis" approach (vs. real-time) — but timing is a design choice, not an invention
- The specific signal taxonomy (frustration signals, pushback tolerance) — possibly novel in the specific combination, but individually each is known
- Modification of external config files (SOUL.md/USER.md) vs. in-model memory — this is the most architecturally distinct element

**Honest assessment:** Weak. The Microsoft patent application is likely to be cited as primary prior art against any claims.

### 4. Provisional Patent Filing

**Cost:** Same as Innovation 1 — **$65 self-filed** or $1,500–$3,500 attorney-assisted.

**What the provisional needs:**
- Detailed description of the analysis pipeline
- Specific algorithms for each signal type (frustration detection, humor classification, etc.)
- The batch processing architecture (why 1 week, how it differs from real-time approaches)
- How config modifications are generated and validated
- The specific file format changes and deployment process
- Any feedback loops or safety mechanisms (preventing bad calibrations)

**The Microsoft problem:**
Microsoft's US20250310281 was published October 2025. If it gets granted, Innovation 2 may infringe. A provisional doesn't protect you from infringing someone else's patent — it only establishes your priority date. Given Microsoft filed first with a broader application, this is concerning.

### 5. Recommendation: **FILE PROVISIONAL (Self-File), But Eyes Wide Open**

**Rationale:**
- $65 is still trivial
- "Patent Pending" value applies here too
- The specific implementation details (batch job architecture, external config file modification, specific signal taxonomy) are different enough from Microsoft's approach to warrant documenting
- Combined with Innovation 1, two provisionals make a better IP story than one
- **Do NOT spend money on attorney prosecution** unless something changes dramatically

**Key risk:** Microsoft's patent application covers the core concept. Even if you get a provisional filed, converting to non-provisional is likely a waste of money given the prior art landscape.

---

## Combined Filing Strategy

### Recommended Approach: Single Provisional Covering Both Innovations

Instead of two separate filings, draft **one provisional application** covering the entire system:

1. Psychometric quiz → configuration pipeline (Innovation 1)
2. Ongoing conversation analysis → autonomous calibration (Innovation 2)
3. **The combination** — a system that initializes via psychometric assessment AND continuously refines via conversation analysis

**Why combine?** The combination is arguably more novel than either piece alone. No identified prior art covers the full pipeline of: psychometric initialization → deployment → conversation monitoring → autonomous refinement → config update → redeployment. The closed-loop system is the strongest inventive argument.

**Filing cost: $65** (single micro entity provisional)

### Cost Summary

| Approach | Cost | Value |
|----------|------|-------|
| Self-file single provisional (micro entity) | $65 | "Patent Pending" status, priority date, 12-month option |
| Self-file two provisionals | $130 | Slightly broader coverage |
| Attorney-drafted provisional | $2,000–$4,000 | Better claims drafting, stronger priority date |
| Convert to non-provisional (12 months later) | $8,000–$15,000+ | Actual patent prosecution |

**Recommendation: Self-file single combined provisional for $65.**

### Timeline

- **Now (Feb 2026):** File provisional
- **Aug 2026:** Reassess based on ClawDaddy traction, funding, competitive landscape
- **Feb 2027:** Decision point — convert to non-provisional ($$$) or let it lapse (free)
- If raising money or in acquisition talks → convert
- If bootstrapping and no enforcement need → let it lapse, file new provisional with updated implementation details if desired

---

## Honest Assessment for Pearson

### What's strong:
- The specific technical pipeline (quiz → scoring → normalization → parameter derivation → template generation → deployment) is concrete enough to describe in patent language
- The combined system (psychometric init + conversation calibration) is more novel than either alone
- No identified patent covers this exact end-to-end pipeline
- "Patent pending" has real marketing and acquisition value

### What's weak:
- **§101 is a serious problem.** Both innovations are fundamentally "use a computer to automate a mental process." Post-Alice, this is the #1 killer of software patents.
- **Prior art is thick.** The Arxiv paper on Big Five → AI personality assignment, Microsoft's conversation-history personalization patent, and multiple commercial products (Pi, ChatGPT Memory, Replika, Character.ai) all cut against novelty.
- **Microsoft is in this space.** Their US20250310281 patent application is close enough to Innovation 2 that it could be blocking if granted.
- **Enforceability is near-zero.** Even if granted, enforcing a software patent against well-funded competitors (OpenAI, Microsoft, Google) is a money pit. Pearson knows this from Rare Breed Triggers — patent litigation is expensive and uncertain even with strong patents.
- **19+ competitors in the hosting space** means the "patent pending" deterrent effect is limited. Competitors will likely build similar features regardless.

### The real value proposition:
The $65 provisional buys you:
1. **"Patent Pending"** on your website, pitch decks, and marketing materials for 12 months
2. A **documented priority date** in case someone tries to patent the same thing later
3. An **IP line item** on your asset sheet for acquisition discussions
4. **12 months of optionality** to decide whether to invest further

For a startup, that's a good deal at $65. Just don't confuse "patent pending" with "patented" or "defensible IP moat." It's a marketing tool and a cheap option, not a fortress.

### What NOT to do:
- Don't spend $3,000+ on attorney-drafted provisionals at this stage
- Don't cite "patent pending" as a competitive moat to investors without qualifying it
- Don't assume this prevents anyone from building the same thing
- Don't convert to non-provisional unless you have specific strategic reasons (acquisition, funding requirement, identified infringer)

---

## Appendix: Key References

### Patents & Applications
| Reference | Title | Relevance |
|-----------|-------|-----------|
| US20250310281 (Microsoft, 2025) | Contextualizing Chat Responses Based on Conversation History | Builds user profiles from prior conversations for personalization — near-identical to Innovation 2 |
| US20070048706A1 | Psychometric Assessment Tool | Earlier personality quiz → interpretation pipeline patent |
| US Patent 10,440,181 (Revenue.io, 2019) | Adaptive Real-Time Conversational Systems | Conversation monitoring and element extraction for adaptation |
| US20120016678A1 (Apple) | Intelligent Automated Assistant (Siri) | Short/long term memory, user profile, contextual adaptation |
| Microsoft (2021) | Chatbot Personality from Social Data | Training chatbots to replicate specific person's personality |

### Academic Papers
| Reference | Relevance |
|-----------|-----------|
| "Designing AI-Agents with Personalities: A Psychometric Approach" (Arxiv 2410.19238, Oct 2024) | Big Five framework → AI agent personality assignment. Most directly relevant prior art for Innovation 1. |

### Commercial Products (Prior Art)
| Product | Relevance |
|---------|-----------|
| Character.ai | User-created AI personalities with behavioral parameters |
| Pi by Inflection AI | Adaptive learning of user preferences and interaction style |
| ChatGPT Memory (OpenAI) | Automatic preference learning across conversations |
| Replika | Communication style adaptation from ongoing conversations (since ~2017) |
| OpenAI Custom GPTs | Manual AI personality configuration via instructions |
| AgentPsy | Personalized agent configuration from psychological assessments |

### Key Case Law
| Case | Holding | Relevance |
|------|---------|-----------|
| Alice Corp v. CLS Bank (2014) | Abstract ideas implemented on generic computers are not patentable | Primary §101 challenge framework |
| Enfish v. Microsoft (2016) | Claims directed to specific improvement in computer functionality can survive Step 1 | Best-case analogy, but ClawDaddy's claims don't improve computer functionality per se |
| BASCOM v. AT&T (2016) | Non-conventional ordered combination of known elements can satisfy Step 2 | Possible argument for the specific pipeline architecture |

---

*This analysis is for internal strategic planning only. It does not constitute legal advice. Consult a registered patent attorney before making filing decisions.*
