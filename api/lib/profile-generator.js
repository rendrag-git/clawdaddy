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
    `independent_vs_collaborative: ${(scores.independent_vs_collaborative || 0.5).toFixed(2)} (0=collaborative, 1=independent)`
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

  const prompt = `You are generating personalized configuration files for a ClawDaddy AI assistant.

ClawDaddy is a personal AI assistant platform that creates customized AI helpers based on user preferences. Each assistant is configured with three core files:
- SOUL.md: The assistant's personality, communication style, and behavioral preferences
- USER.md: The user's profile, preferences, and help areas
- IDENTITY.md: The assistant's identity and character description

# User Quiz Results

## Personality Dimension Scores:
${dimensionDescriptions}

## Selected Use Cases:
Personal areas: ${personalAreas.length > 0 ? personalAreas.join(', ') : 'None'}
Work areas: ${workAreas.length > 0 ? workAreas.join(', ') : 'None'}
Interaction frequency: ${usage}

## Free-Text Responses:
${freeTextSection || 'None provided'}

${contextSection ? `## Additional Context from Quiz:\n${contextSection}` : ''}

# Configuration Details
- Username: ${username}
- Bot Name: ${botName}

# Your Task

Generate three personalized markdown files for this user's AI assistant. Write in natural, engaging language that incorporates the user's actual responses. DO NOT write generic templates — reference their specific traits, use cases, and free-text responses.

## SOUL.md Guidelines:
- Define the assistant's personality based on the dimension scores
- Specify tone (formal/casual), humor level and style, verbosity, proactivity
- Describe collaboration style and how to handle disagreements
- Use natural language that reflects the quiz results
- Include specific behavioral preferences derived from scores

## USER.md Guidelines:
- Include preferred name, role, and interaction frequency
- List personal and professional help areas from tags
- Describe communication preferences based on detail/autonomy scores
- Incorporate any free-text responses naturally
- Keep it focused on information the assistant needs to serve the user well

## IDENTITY.md Guidelines:
- Give the bot a creative character description that fits the personality traits
- Create a memorable "vibe" or one-line essence statement
- Make it unique and personalized, not generic
- The character should feel like it naturally embodies the dimension scores

# Output Format

Output the three files separated by these exact markers:
---SOUL.MD---
[SOUL.md content here]
---USER.MD---
[USER.md content here]
---IDENTITY.MD---
[IDENTITY.md content here]

Generate the files now, making them personal, specific, and useful.`;

  const responseText = await callOpenRouter(
    apiKey,
    'anthropic/claude-sonnet-4',
    [{ role: 'user', content: prompt }],
    4000
  );

  // Parse the response
  const soulMatch = responseText.match(/---SOUL\.MD---([\s\S]*?)---USER\.MD---/);
  const userMatch = responseText.match(/---USER\.MD---([\s\S]*?)---IDENTITY\.MD---/);
  const identityMatch = responseText.match(/---IDENTITY\.MD---([\s\S]*?)$/);

  if (!soulMatch || !userMatch || !identityMatch) {
    throw new Error('Failed to parse Claude response - missing expected markers');
  }

  return {
    soulMd: soulMatch[1].trim(),
    userMd: userMatch[1].trim(),
    identityMd: identityMatch[1].trim()
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

  // Usage factor
  const usageTag = tags.find(t => t.startsWith('usage:'));
  const usage = usageTag ? usageTag.split(':')[1] : 'medium';
  const usageFactor = { high: 0.20, medium: 0.10, low: -0.05, minimal: -0.10 }[usage] || 0.10;
  const verbosity = clamp(0.55 * detail + 0.25 * structure + 0.20 * proactivity + usageFactor, 0, 1);

  // Disagreement mode
  let disagreementMode;
  if (proactivity > 0.62 && autonomy < 0.45) disagreementMode = 'coach';
  else if (proactivity > 0.62 && autonomy >= 0.45) disagreementMode = 'advisor';
  else if (proactivity <= 0.62 && autonomy >= 0.55) disagreementMode = 'executor';
  else disagreementMode = 'collaborator';

  // Humor style
  let humorStyle;
  if (humor > 0.70 && casualness > 0.55) humorStyle = 'witty sidekick';
  else if (humor > 0.70) humorStyle = 'light & friendly';
  else if (humor > 0.40) humorStyle = 'occasional smiles';
  else humorStyle = 'straightforward';

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
- For technical help: show runnable steps, small examples, and sanity checks.`;

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

  return { soulMd, userMd, identityMd };
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
