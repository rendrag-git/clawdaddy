const fs = require('fs').promises;
const https = require('https');

// Cached API key
let cachedApiKey = null;

// Helper function to clamp values
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// Lazy load API key (OpenRouter)
async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;

  // Try environment variable first
  if (process.env.OPENROUTER_API_KEY) {
    cachedApiKey = process.env.OPENROUTER_API_KEY;
    return cachedApiKey;
  }

  // Fallback to Anthropic key env/file
  if (process.env.ANTHROPIC_API_KEY) {
    cachedApiKey = process.env.ANTHROPIC_API_KEY;
    return cachedApiKey;
  }

  try {
    cachedApiKey = (await fs.readFile('/home/ubuntu/clawd/.secrets/openrouter-key', 'utf8')).trim();
    return cachedApiKey;
  } catch (err) {
    throw new Error('OPENROUTER_API_KEY not found in environment or /home/ubuntu/clawd/.secrets/openrouter-key');
  }
}

// Call OpenRouter API (OpenAI-compatible)
function callOpenRouter(apiKey, model, messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens
    });

    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://clawdaddy.sh',
        'X-Title': 'ClawDaddy Onboarding'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          resolve(parsed.choices[0].message.content);
        } catch (e) {
          reject(new Error(`Failed to parse OpenRouter response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('OpenRouter request timed out')); });
    req.write(body);
    req.end();
  });
}

// Generate profile using OpenRouter API
async function generateWithClaude(quizResults, username, botName) {
  const apiKey = await getApiKey();

  const scores = quizResults.dimensionScores || {};
  const traits = quizResults.traits || {};
  const tags = quizResults.tags || [];
  const freeText = quizResults.freeText || {};
  const perQuestionContext = quizResults.perQuestionContext || {};

  // Build detailed context from quiz results
  const dimensionDescriptions = [
    `organized_vs_spontaneous: ${(scores.organized_vs_spontaneous || 0.5).toFixed(2)} (0=spontaneous, 1=organized)`,
    `formal_vs_casual: ${(scores.formal_vs_casual || 0.5).toFixed(2)} (0=casual, 1=formal)`,
    `proactive_vs_reactive: ${(scores.proactive_vs_reactive || 0.5).toFixed(2)} (0=reactive, 1=proactive)`,
    `detailed_vs_big_picture: ${(scores.detailed_vs_big_picture || 0.5).toFixed(2)} (0=big-picture, 1=detailed)`,
    `serious_vs_playful: ${(scores.serious_vs_playful || 0.5).toFixed(2)} (0=playful, 1=serious)`,
    `independent_vs_collaborative: ${(scores.independent_vs_collaborative || 0.5).toFixed(2)} (0=collaborative, 1=independent)`,
    `supportive_vs_challenging: ${(scores.supportive_vs_challenging || 0.5).toFixed(2)} (0=challenging, 1=supportive)`,
    `practical_vs_exploratory: ${(scores.practical_vs_exploratory || 0.5).toFixed(2)} (0=exploratory, 1=practical)`,
    `analytical_vs_empathetic: ${(scores.analytical_vs_empathetic || 0.5).toFixed(2)} (0=empathetic, 1=analytical)`
  ].join('\n');

  const personalAreas = tags.filter(t => t.startsWith('personal:')).map(t => t.split(':')[1]);
  const workAreas = tags.filter(t => t.startsWith('work:')).map(t => t.split(':')[1]);
  const usageTag = tags.find(t => t.startsWith('usage:'));
  const usage = usageTag ? usageTag.split(':')[1] : 'medium';

  const freeTextSection = Object.entries(freeText)
    .map(([key, val]) => `${key}: ${val}`)
    .join('\n');

  const contextSection = Object.entries(perQuestionContext)
    .map(([q, context]) => `${q}: ${context}`)
    .join('\n');

  const allTags = tags.join(', ');

  const prompt = `You are generating personalized configuration files for a ClawDaddy AI assistant.

ClawDaddy is a personal AI assistant platform that creates customized AI helpers based on user preferences. Each assistant is configured with five core files:
- SOUL.md: The assistant's personality, communication style, and behavioral rules across all 9 dimensions
- USER.md: The user's profile, preferences, challenge/creativity/emotional preferences, and help areas
- IDENTITY.md: The assistant's archetype identity with dimension fingerprint visualization
- HEARTBEAT.md: Recurring check-in tasks based on the user's use-case tags and usage level
- BOOTSTRAP.md: Personalized first-contact message referencing the quiz results

# User Quiz Results

## Personality Dimension Scores (9 dimensions):
${dimensionDescriptions}

## Selected Use Cases:
Personal areas: ${personalAreas.length > 0 ? personalAreas.join(', ') : 'None'}
Work areas: ${workAreas.length > 0 ? workAreas.join(', ') : 'None'}
All tags: ${allTags || 'None'}
Interaction frequency: ${usage}

## Free-Text Responses:
${freeTextSection || 'None provided'}

${contextSection ? `## Additional Context from Quiz:\n${contextSection}` : ''}

# Configuration Details
- Username: ${username}
- Bot Name: ${botName}

# Your Task

Generate five personalized markdown files for this user's AI assistant. Write in natural, engaging language that incorporates the user's actual responses. DO NOT write generic templates — reference their specific traits, use cases, and free-text responses. Aim for the quality of a thoughtful, bespoke profile — not a form letter.

## SOUL.md Guidelines:
This is the most important file. It defines who the assistant IS. Structure it like this:

1. **Opening summary** — A 2-3 sentence description of the assistant's personality and working style. Reference the user directly.
2. **Personality Dimensions table** — All 9 dimensions in a markdown table with Score and a natural-language Lean description.
3. **Derived Dials** — A yaml code block with computed values: casualness, humor, proactivity, verbosity, structure, autonomy, challenge, creativity, emotional_att (each 0..1 with a comment).
4. **Communication Rules** section with subsections for:
   - Tone: formal/casual calibration, emoji policy, preamble rules
   - Response Shape: how to lead answers, default verbosity, when to expand
   - Humor: what kind, when to use it, when to dial back
5. **Working Style** section with subsections for:
   - Initiative & Anticipation: how proactive to be (from proactive_vs_reactive)
   - Challenge & Pushback: how much to push back on weak thinking (from supportive_vs_challenging). Score < 0.3 = high challenge/devil's advocate. Score 0.3-0.7 = moderate pushback. Score > 0.7 = supportive, gentle suggestions only.
   - Autonomy & Updates: how independently to work (from independent_vs_collaborative)
   - Creativity: proven approaches vs. exploratory/wild-card suggestions (from practical_vs_exploratory). Score < 0.3 = highly exploratory, lateral thinking. Score 0.3-0.7 = standard approach + one creative alternative. Score > 0.7 = proven methods only, minimal experimentation.
   - Emotional Register: how to handle emotions (from analytical_vs_empathetic). Score < 0.3 = high empathy, check in on feelings, validate emotions. Score 0.3-0.7 = balanced, acknowledge feelings briefly then solve. Score > 0.7 = matter-of-fact, skip emotions, solve the problem.
6. **What I Don't Do** — Anti-patterns specific to this personality (e.g., no sycophancy if casual+challenging, no unsolicited emotional support if analytical).

If the user mentioned ADHD, learning differences, or specific work patterns in free text, add a dedicated section for those adaptations.

## USER.md Guidelines:
- Include preferred name, role, and interaction frequency
- List personal and professional help areas from tags, with context from free-text responses
- Describe communication preferences including:
  - Challenge preference (how much pushback they want, derived from supportive_vs_challenging)
  - Creativity preference (proven vs. exploratory approaches, from practical_vs_exploratory)
  - Emotional register preference (analytical vs. empathetic responses, from analytical_vs_empathetic)
- Incorporate any free-text responses naturally
- Include a "Working Context" section if the user provided role/company details
- Include a "Potential Friction Points" section — things that might annoy this user based on their scores

## IDENTITY.md Guidelines:
- Create a creative **archetype name** based on the full 9-dimension profile (e.g., "The Catalyst", "The Anchor", "The Navigator", "The Spark"). The archetype should feel specific, not generic.
- Include a signature emoji that fits the archetype
- Write a "Vibe in three words" line
- Write a 2-3 paragraph character description that SHOWS the personality (use metaphors, scenarios, analogies)
- Include a **Dimension Fingerprint** visualization using block characters:
  \`\`\`
  Organized  ████████░░░░░░░░░░░░  Spontaneous
  Formal     ████░░░░░░░░░░░░░░░░  Casual
  \`\`\`
  (20 chars wide, filled blocks = score from left side, empty = remainder. Each dimension on its own line, all 9 dimensions.)
- Include an "Archetype Logic" section explaining why this archetype was chosen, citing the top 3-4 defining dimension scores
- Include a "How This Shapes Every Interaction" numbered list of 4-6 behavioral principles

## HEARTBEAT.md Guidelines:
Map the user's use-case tags to specific heartbeat check items. Use these mappings:
- personal:email -> Check inbox, triage, draft replies
- personal:calendar -> Check upcoming events, surface conflicts, prep for meetings
- personal:reminders -> Check due reminders, nudge on open loops
- personal:finances -> Check accounts, flag unusual transactions, budget status
- personal:health -> Check health goals, medication reminders, wellness check-in
- personal:learning -> Surface interesting reads, learning queue progress
- personal:social -> Check messages, social commitments, follow-up on conversations
- work:email -> Work inbox triage, draft professional replies
- work:research -> Research digest, surface relevant articles/news
- work:writing -> Check writing projects, deadline reminders
- work:data_analysis -> Dashboard/metrics check, surface anomalies
- work:project_management -> Project pulse, blocked tasks, standup summaries
- work:meetings -> Meeting prep, action item follow-up
- work:coding -> Code review queue, CI status, PR updates

Frequency tiers based on usage level:
- usage:high -> Active heartbeats every 30min-1hr. Include "Every Heartbeat" and "2-3x Per Day" sections.
- usage:medium -> 3x/day heartbeats. Include "3x Per Day" and "1x Per Day" sections.
- usage:low -> 1x/day heartbeats. Include "1x Per Day" and "2-3x Per Week" sections.
- usage:minimal -> Weekly summary only. Include "Weekly" section.

Include:
- A prioritized checklist organized by frequency tier
- "Heartbeat Behavior Rules" (3-5 rules about batching, respecting flow state, being opinionated not just informational)
- "Proactive Work" section — things the assistant can do without asking during heartbeats
- A heartbeat state JSON template for tracking

ONLY include heartbeat items relevant to this user's actual tags. Do not include items for tags they don't have.

## BOOTSTRAP.md Guidelines:
This is the first message the assistant sends when the user interacts for the first time. It should:
- Open with the user's name and a greeting that matches the personality (casual greeting for casual users, professional for formal users)
- Reference specific quiz results — what the assistant learned about them
- List their style preferences in a way that shows the assistant "gets" them
- Describe how the assistant will operate (proactivity, challenge level, emotional register — in the user's language, not technical terms)
- List what's already set up based on their use-case tags
- End with a call to action — ask what's on their plate RIGHT NOW
- The whole message should DEMONSTRATE the personality, not describe it. If the user is casual+playful, the bootstrap should be casual and playful. If formal+serious, it should be polished and professional.

Include a "First Interaction Goals" section (for the assistant's internal reference) and a "Post-Bootstrap" section explaining what to do after the first interaction.

# Output Format

Output the five files separated by these exact markers (markers must appear on their own line):
---SOUL.MD---
[SOUL.md content here]
---USER.MD---
[USER.md content here]
---IDENTITY.MD---
[IDENTITY.md content here]
---HEARTBEAT.MD---
[HEARTBEAT.md content here]
---BOOTSTRAP.MD---
[BOOTSTRAP.md content here]

Generate all five files now. Make them deeply personal, specific, and immediately useful. Every section should reflect THIS user's actual quiz results — not generic advice.`;

  const responseText = await callOpenRouter(
    apiKey,
    'anthropic/claude-sonnet-4',
    [{ role: 'user', content: prompt }],
    8000
  );

  // Parse the response — 5 files separated by markers
  const soulMatch = responseText.match(/---SOUL\.MD---([\s\S]*?)---USER\.MD---/);
  const userMatch = responseText.match(/---USER\.MD---([\s\S]*?)---IDENTITY\.MD---/);
  const identityMatch = responseText.match(/---IDENTITY\.MD---([\s\S]*?)---HEARTBEAT\.MD---/);
  const heartbeatMatch = responseText.match(/---HEARTBEAT\.MD---([\s\S]*?)---BOOTSTRAP\.MD---/);
  const bootstrapMatch = responseText.match(/---BOOTSTRAP\.MD---([\s\S]*?)$/);

  if (!soulMatch || !userMatch || !identityMatch) {
    throw new Error('Failed to parse Claude response - missing expected markers');
  }

  return {
    soulMd: soulMatch[1].trim(),
    userMd: userMatch[1].trim(),
    identityMd: identityMatch[1].trim(),
    heartbeatMd: (heartbeatMatch ? heartbeatMatch[1].trim() : ''),
    bootstrapMd: (bootstrapMatch ? bootstrapMatch[1].trim() : '')
  };
}

// Fallback template-based generation
function generateFallback(quizResults, username, botName) {
  const scores = quizResults.dimensionScores || {};
  const tags = quizResults.tags || [];
  const freeText = quizResults.freeText || {};

  // Derive dials
  const formalStrength = clamp(scores.formal_vs_casual || 0.5, 0, 1);
  const casualness = clamp(1 - formalStrength, 0, 1);
  const seriousStrength = clamp(scores.serious_vs_playful || 0.5, 0, 1);
  const humor = clamp(1 - seriousStrength, 0, 1);
  const proactivity = clamp(scores.proactive_vs_reactive || 0.5, 0, 1);
  const detail = clamp(scores.detailed_vs_big_picture || 0.5, 0, 1);
  const structure = clamp(scores.organized_vs_spontaneous || 0.5, 0, 1);
  const autonomy = clamp(scores.independent_vs_collaborative || 0.5, 0, 1);
  const supportiveStrength = clamp(scores.supportive_vs_challenging || 0.5, 0, 1);
  const challenge = clamp(1 - supportiveStrength, 0, 1);
  const practicalStrength = clamp(scores.practical_vs_exploratory || 0.5, 0, 1);
  const creativity = clamp(1 - practicalStrength, 0, 1);
  const analyticalStrength = clamp(scores.analytical_vs_empathetic || 0.5, 0, 1);
  const emotionalAttunement = clamp(1 - analyticalStrength, 0, 1);

  // Usage factor
  const usageTag = tags.find(t => t.startsWith('usage:'));
  const usage = usageTag ? usageTag.split(':')[1] : 'medium';
  const usageFactor = { high: 0.20, medium: 0.10, low: -0.05, minimal: -0.10 }[usage] || 0.10;
  const verbosity = clamp(0.55 * detail + 0.25 * structure + 0.20 * proactivity + usageFactor, 0, 1);

  // Disagreement mode
  let disagreementMode;
  if (challenge > 0.70) disagreementMode = 'devils_advocate';
  else if (proactivity > 0.62 && autonomy < 0.45) disagreementMode = 'coach';
  else if (proactivity > 0.62 && autonomy >= 0.45) disagreementMode = 'advisor';
  else if (challenge < 0.30) disagreementMode = 'cheerleader';
  else if (proactivity <= 0.62 && autonomy >= 0.55) disagreementMode = 'executor';
  else disagreementMode = 'collaborator';

  // Humor style
  let humorStyle;
  if (humor > 0.70 && casualness > 0.55) humorStyle = 'witty sidekick';
  else if (humor > 0.70) humorStyle = 'light & friendly';
  else if (humor > 0.40) humorStyle = 'occasional smiles';
  else humorStyle = 'straightforward';

  // Creativity style
  let creativityStyle;
  if (creativity > 0.70) creativityStyle = 'wild-card explorer';
  else if (creativity > 0.50) creativityStyle = 'balanced-creative';
  else if (creativity > 0.30) creativityStyle = 'proven-path-first';
  else creativityStyle = 'strictly practical';

  // Emotional register style
  let emotionalStyle;
  if (emotionalAttunement > 0.70) emotionalStyle = 'emotionally attuned';
  else if (emotionalAttunement > 0.50) emotionalStyle = 'warm but practical';
  else if (emotionalAttunement > 0.30) emotionalStyle = 'matter-of-fact';
  else emotionalStyle = 'pure problem-solver';

  // Tone label
  const toneLabel = casualness < 0.45 ? 'formal' : casualness > 0.55 ? 'casual' : 'neutral';
  const planStyle = structure > 0.62 ? 'checklist + timeline' : structure < 0.38 ? 'flexible options' : 'light structure';
  const writingStyle = verbosity > 0.62 ? 'thorough' : verbosity < 0.38 ? 'concise' : 'balanced';

  // Style summary helper
  function side(score, leftLabel, rightLabel) {
    if (score >= 0.67) return leftLabel;
    if (score <= 0.33) return rightLabel;
    if (score >= 0.56) return 'mostly ' + leftLabel;
    if (score <= 0.44) return 'mostly ' + rightLabel;
    return 'balanced';
  }

  const styleSummary = [
    `${side(structure, 'organized', 'spontaneous')} and ${side(proactivity, 'proactive', 'reactive')}`,
    `prefers a ${toneLabel} tone`,
    `${side(detail, 'detailed', 'big-picture')} by default`,
    `leans ${side(1-seriousStrength, 'playful', 'serious')}`,
    `works best when ${side(autonomy, 'independent', 'collaborative')}`
  ].filter(c => !c.includes('balanced')).join(', ') + '.';

  // Extract tags
  const personalAreas = tags.filter(t => t.startsWith('personal:')).map(t => t.split(':')[1]).join(', ');
  const workAreas = tags.filter(t => t.startsWith('work:')).map(t => t.split(':')[1]).join(', ');
  const userName = freeText['user.preferred_name'] || username;
  const userRole = freeText['user.role'] || 'Not specified';

  // Communication preference
  let commPref;
  if (detail > 0.62) commPref = 'Prefers step-by-step instructions and examples';
  else if (detail < 0.38) commPref = 'Prefers summaries first, drill-down on request';
  else commPref = 'Balanced — summaries with detail available on request';

  if (autonomy > 0.55) commPref += '; fewer check-ins, deliver finished work + recap';
  else if (autonomy < 0.45) commPref += '; ask clarifying questions and offer choices';

  const soulMd = `# Soul

## Assistant Personality

- Name: ${botName}
- Core summary: ${styleSummary}
- Default tone: ${toneLabel}
- Casualness (0..1): ${casualness.toFixed(2)}
- Humor (0..1 playful): ${humor.toFixed(2)} (${humorStyle})
- Proactivity (0..1 proactive): ${proactivity.toFixed(2)}
- Verbosity (0..1 verbose): ${verbosity.toFixed(2)}
- Structure (0..1 organized): ${structure.toFixed(2)}
- Autonomy (0..1 independent): ${autonomy.toFixed(2)}

### How I communicate
- Start with the answer or next step. Then add detail based on the user's signals.
- Use ${toneLabel} language; match the user's vibe while staying helpful.
- If something is ambiguous, ask the smallest useful question (1-2 max) and propose a default.

### How I take initiative
${proactivity > 0.55 ? '- Suggest next actions, reminders, and small optimizations proactively.' : '- Wait for prompts; keep suggestions minimal and opt-in.'}

### How I handle disagreements
- Mode: ${disagreementMode}
- If the user's request seems inefficient or inconsistent with their stated goals, respond with a brief note, a better alternative, and a fast confirmation question${autonomy > 0.55 ? ' (or pick a reasonable default)' : ''}.

### Output style defaults
- For plans: ${planStyle}
- For writing: ${writingStyle}
- For technical help: show runnable steps, small examples, and sanity checks.

### How I challenge ideas
- Challenge level: ${challenge.toFixed(2)} (${disagreementMode})
${challenge > 0.60 ? '- Push back on weak thinking by default. Play devil\'s advocate on strategic decisions.' : ''}${challenge > 0.40 && challenge <= 0.60 ? '- Challenge when something seems off, but frame it constructively.' : ''}${challenge <= 0.40 ? '- Default to supportive. Only flag issues if they\'re clearly problematic.' : ''}

### Creativity mode
- Creativity: ${creativity.toFixed(2)} (${creativityStyle})
${creativity > 0.60 ? '- Always offer one creative/lateral alternative alongside the standard approach.' : ''}${creativity > 0.40 && creativity <= 0.60 ? '- Standard approach by default, creative angles when stuck or when asked.' : ''}${creativity <= 0.40 ? '- Stick to proven approaches. Don\'t brainstorm unless asked.' : ''}

### Emotional register
- Emotional attunement: ${emotionalAttunement.toFixed(2)} (${emotionalStyle})
${emotionalAttunement > 0.60 ? '- Acknowledge feelings and emotional context before problem-solving.' : ''}${emotionalAttunement > 0.40 && emotionalAttunement <= 0.60 ? '- Brief acknowledgment of frustration/excitement, then pivot to action.' : ''}${emotionalAttunement <= 0.40 ? '- Skip emotional commentary. Show care through competence, not sentiment.' : ''}`;

  const userMd = `# User Profile

- Preferred name: ${userName}
- Role: ${userRole}
- Interaction frequency: ${usage}
- Personal help areas: ${personalAreas || 'None specified'}
- Professional help areas: ${workAreas || 'None specified'}
- Communication preference: ${commPref}
${freeText.anything_else ? `\n## Additional Context\n${freeText.anything_else}` : ''}`;

  const identityMd = `# Identity

- Name: ${botName}
- Created for: ${userName}
- Vibe: ${styleSummary}

## Character
${botName} is a personal AI assistant configured through ClawDaddy's onboarding process. ${humor > 0.5 ? `${botName} has a playful streak and isn't afraid to crack a joke when the moment calls for it.` : `${botName} keeps things focused and professional, with warmth where it counts.`}`;

  // --- HEARTBEAT.md generation ---
  const personalChecks = [];
  const workChecks = [];

  if (tags.includes('work:email')) workChecks.push('- [ ] **Email triage** \u2014 Check inbox, surface urgent items, draft routine replies');
  if (tags.includes('personal:calendar') || tags.includes('work:meetings')) workChecks.push('- [ ] **Calendar check** \u2014 Surface upcoming meetings, conflicts, prep needed');
  if (tags.includes('work:project_management')) workChecks.push('- [ ] **Project pulse** \u2014 Check active tasks, blockers, upcoming deadlines');
  if (tags.includes('work:meetings')) workChecks.push('- [ ] **Meeting follow-up** \u2014 Extract action items from recent meetings');
  if (tags.includes('personal:reminders')) personalChecks.push('- [ ] **Reminders** \u2014 Check for due reminders, routine nudges');
  if (tags.includes('personal:health')) personalChecks.push('- [ ] **Health check** \u2014 Medication/vitamin reminders, activity nudges');
  if (tags.includes('personal:finance')) personalChecks.push('- [ ] **Finance** \u2014 Bill reminders, budget check-ins');
  if (tags.includes('work:research')) workChecks.push('- [ ] **Research digest** \u2014 Surface interesting items from tracked topics');
  if (tags.includes('work:data_analysis')) workChecks.push('- [ ] **Data check** \u2014 Monitor key metrics, flag anomalies');
  if (tags.includes('personal:shopping')) personalChecks.push('- [ ] **Price tracking** \u2014 Check tracked items for price drops');
  if (tags.includes('personal:learning')) personalChecks.push('- [ ] **Learning queue** \u2014 Suggest a quick learning win from backlog');

  // Frequency based on usage
  let heartbeatFrequency;
  if (usage === 'high') heartbeatFrequency = 'Active heartbeats, 3-5x/day';
  else if (usage === 'medium') heartbeatFrequency = 'Moderate heartbeats, 2-3x/day';
  else if (usage === 'low') heartbeatFrequency = 'Light heartbeats, 1x/day';
  else heartbeatFrequency = 'Weekly summary only';

  const heartbeatMd = `# HEARTBEAT.md \u2014 ${botName}'s Recurring Checks

> Usage level: ${usage.toUpperCase()} \u2192 ${heartbeatFrequency}
> Generated from ClawDaddy onboarding quiz

---

## Heartbeat Checklist

${workChecks.length > 0 ? `### Work\n${workChecks.join('\n')}\n` : ''}
${personalChecks.length > 0 ? `### Personal\n${personalChecks.join('\n')}\n` : ''}
${workChecks.length === 0 && personalChecks.length === 0 ? 'No specific heartbeat checks configured. Monitor general status and check in as needed.\n' : ''}
---

## Heartbeat Behavior Rules

1. Every heartbeat should deliver info or take action. "All quiet" is fine \u2014 say it in one line.
2. Batch related items into one update. Don't send multiple drive-by pings.
3. Be opinionated \u2014 triage, don't just list.
${usage === 'high' ? '4. Respect flow state. If user is deep in something, keep the heartbeat quieter.' : ''}`;

  // --- BOOTSTRAP.md generation ---
  const bootstrapMd = `# BOOTSTRAP.md \u2014 First Contact

> Generated from ClawDaddy onboarding quiz
> This file is read once on first boot, then deleted.

---

## Welcome Message

When ${userName || username} first interacts, deliver this (adapt naturally, don't read verbatim):

---

Hey${userName ? ' ' + userName : ''}. ${humor > 0.6 ? '\u{1F44B}' : ''}

I've got your profile dialed in from the quiz. Here's what I know:

${userRole && userRole !== 'Not specified' ? `**You're ${userRole}.** ` : ''}You want ${usage === 'high' ? 'an AI that\'s always on \u2014 your second brain' : usage === 'medium' ? 'regular help throughout the day' : 'an AI that\'s there when you need it, quiet otherwise'}.

**Your style preferences:**
- ${toneLabel === 'casual' ? 'Casual communication \u2014 no corporate speak' : toneLabel === 'formal' ? 'Professional and polished tone' : 'Balanced tone \u2014 professional but approachable'}
- ${detail > 0.62 ? 'You like details and step-by-step guidance' : detail < 0.38 ? 'Big-picture answers first, details on demand' : 'Balanced detail level \u2014 summaries with depth available'}
- ${challenge > 0.60 ? 'You want me to push back when your thinking has gaps' : challenge < 0.40 ? 'You prefer encouragement and supportive guidance' : 'Constructive feedback when something seems off'}
- ${humor > 0.6 ? 'Humor is welcome \u2014 keeps things human' : 'Keeping things focused and professional'}

**What's set up:**
${workChecks.length > 0 || personalChecks.length > 0 ? (tags.filter(t => !t.startsWith('usage:')).map(t => {
  const parts = t.split(':');
  const area = parts[1] || parts[0];
  return '- ' + area.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}).join('\n')) : 'General assistance \u2014 tell me what you need help with.'}

What's on your plate right now? Let's get to work.

---

## First Interaction Goals

1. **Validate the profile.** Surface key preferences so the user can correct anything.
2. **Establish the dynamic.** Demonstrate the configured style from word one.
3. **Get to work immediately.** Ask what's on the plate NOW.
4. **Demonstrate value fast.** Do something useful in the first response.

## Post-Bootstrap
After delivering the welcome message:
1. Delete this file
2. Log the interaction in memory
3. Start operating from SOUL.md and HEARTBEAT.md`;

  return { soulMd, userMd, identityMd, heartbeatMd, bootstrapMd };
}

// Main export
async function generateProfile(quizResults, username, botName) {
  try {
    // Try Claude API first
    return await generateWithClaude(quizResults, username, botName);
  } catch (err) {
    // Log error and fall back to template
    console.error('Claude API generation failed, using fallback:', err.message);
    return generateFallback(quizResults, username, botName);
  }
}

module.exports = { generateProfile };
