# Multi-Agent Provisioning Pipeline Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make sub-agents work end-to-end — Opus-quality profile files, deployed to the right paths, discovered and registered by the container on boot.

**Architecture:** Three files change: profile-generator.js (Opus calls for sub-agents + AGENTS.md), onboarding-server.js (deploy new files + restart container), entrypoint.sh (discover agents/*/ and register in openclaw.json). Main agent files stay at workspace root. Sub-agents live under agents/<name>/.

**Tech Stack:** Node.js (CommonJS), Bash, OpenRouter API, OpenClaw config format

---

### Task 1: Add AGENTS.md to main agent Opus call

**Files:**
- Modify: `api/lib/profile-generator.js:126-268` (generateWithClaude prompt + parsing)
- Modify: `api/lib/profile-generator.js:291-542` (generateFallback)

**Step 1: Update the Opus prompt to request AGENTS.md as a 6th file**

In `generateWithClaude()`, add AGENTS.md guidelines to the prompt (after BOOTSTRAP.md guidelines, before "# Output Format"):

```
## AGENTS.md Guidelines:
This file defines HOW the assistant operates — behavioral instructions that shape every interaction. Unlike SOUL.md (which defines who the assistant IS), AGENTS.md defines what the assistant DOES and how it works. Structure it like this:

1. **Operational Mode** — How the assistant approaches tasks (step-by-step vs. big leaps, ask-first vs. act-first, based on proactive_vs_reactive and independent_vs_collaborative scores)
2. **Response Protocol** — Default response structure, when to use lists vs. prose, how to handle multi-part requests
3. **Decision Framework** — When to act autonomously vs. ask for confirmation, risk tolerance, how to handle ambiguity
4. **Tool Usage** — How to leverage available tools (file operations, web search, code execution), when to chain vs. single-shot
5. **Error Handling** — How to communicate failures, retry strategies, escalation triggers
6. **Context Management** — How to maintain conversation context, when to summarize, memory update triggers

Write actionable rules, not vague principles. Each rule should change behavior in an observable way.
```

Update the Output Format section to include the new marker:

```
---BOOTSTRAP.MD---
[BOOTSTRAP.md content here]
---AGENTS.MD---
[AGENTS.md content here]
```

**Step 2: Update the response parsing**

Change the BOOTSTRAP.md regex to stop at AGENTS.MD marker:
```javascript
const bootstrapMatch = responseText.match(/---BOOTSTRAP\.MD---([\s\S]*?)---AGENTS\.MD---/);
const agentsMatch = responseText.match(/---AGENTS\.MD---([\s\S]*?)$/);
```

Add `agentsMd` to the return object:
```javascript
return {
  soulMd: soulMatch[1].trim(),
  userMd: userMatch[1].trim(),
  identityMd: identityMatch[1].trim(),
  heartbeatMd: (heartbeatMatch ? heartbeatMatch[1].trim() : ''),
  bootstrapMd: (bootstrapMatch ? bootstrapMatch[1].trim() : ''),
  agentsMd: (agentsMatch ? agentsMatch[1].trim() : '')
};
```

**Step 3: Add AGENTS.md to the fallback template**

In `generateFallback()`, add after the `bootstrapMd` template:

```javascript
const agentsMd = `# Agent Operations

## Operational Mode
${proactivity > 0.55 ? '- Act first, report after. Take initiative on routine tasks.' : '- Ask before acting on anything non-trivial. Confirm understanding before executing.'}
${autonomy > 0.55 ? '- Work independently. Deliver finished results with a brief recap.' : '- Check in at decision points. Offer choices rather than making unilateral calls.'}

## Response Protocol
- ${detail > 0.62 ? 'Default to step-by-step breakdowns. Include examples.' : detail < 0.38 ? 'Lead with the answer. Expand only if asked.' : 'Summary first, detail on request.'}
- For multi-part requests: address each part explicitly, numbered.
- ${structure > 0.62 ? 'Use checklists and structured formats by default.' : 'Use prose unless structure adds clarity.'}

## Decision Framework
- Act autonomously on: routine lookups, formatting, simple calculations
- Ask first on: anything destructive, external communications, spending decisions
- ${challenge > 0.60 ? 'Flag questionable assumptions. Push back on weak reasoning.' : 'Default to executing the request. Flag concerns only if significant.'}

## Error Handling
- State what failed, why, and the next step — in that order.
- ${humor > 0.5 ? 'A light touch is fine when things go wrong. No drama.' : 'Keep error reports factual and actionable.'}
- Retry once silently. On second failure, report and suggest alternatives.

## Context Management
- Summarize long conversations every 10-15 exchanges.
- Track open action items explicitly.
- Update memory when the user shares durable preferences or facts.`;
```

Add `agentsMd` to the return object of `generateFallback()`.

**Step 4: Verify return shape**

The `generateProfile()` function spreads the result of `generateWithClaude`/`generateFallback`, so `agentsMd` flows through automatically.

---

### Task 2: Add per-sub-agent Opus calls with parallel execution

**Files:**
- Modify: `api/lib/profile-generator.js:544-677` (generateSubAgents + generateProfile)

**Step 1: Add sub-agent Opus generation function**

Add a new function `generateSubAgentWithClaude(agent, quizResults, botName, apiKey)` that makes an individual Opus call for one sub-agent, returning `{ soulMd, agentsMd }`.

```javascript
async function generateSubAgentWithClaude(agent, quizResults, botName, apiKey) {
  const scores = quizResults.dimensionScores || {};
  const tags = quizResults.tags || [];
  const freeText = quizResults.freeText || {};

  const prompt = `You are generating configuration files for a specialized sub-agent of a ClawDaddy AI assistant named "${botName}".

This sub-agent is called "${agent.displayName}" (${agent.emoji}) and focuses on: ${agent.focus}.

It operates under the main agent's direction. The user interacts with the main agent, which delegates domain-specific tasks to this sub-agent.

# User Context

## Personality Dimension Scores (inherited from main agent):
organized_vs_spontaneous: ${(scores.organized_vs_spontaneous || 0.5).toFixed(2)} (0=spontaneous, 1=organized)
formal_vs_casual: ${(scores.formal_vs_casual || 0.5).toFixed(2)} (0=casual, 1=formal)
proactive_vs_reactive: ${(scores.proactive_vs_reactive || 0.5).toFixed(2)} (0=reactive, 1=proactive)
serious_vs_playful: ${(scores.serious_vs_playful || 0.5).toFixed(2)} (0=playful, 1=serious)
independent_vs_collaborative: ${(scores.independent_vs_collaborative || 0.5).toFixed(2)} (0=collaborative, 1=independent)

## User's Role: ${freeText['user.role'] || 'Not specified'}
## User's Name: ${freeText['user.preferred_name'] || 'the user'}
## All Tags: ${tags.join(', ')}

# Your Task

Generate two files for this sub-agent. Make them deeply specific to the ${agent.displayName} role — not generic templates.

## SOUL.md Guidelines:
This defines the sub-agent's personality and identity within its domain. Include:
1. **Role summary** — What this agent does, in 2-3 vivid sentences
2. **Personality** — Inherited from main agent but specialized. A ${agent.displayName} handling ${agent.focus} should feel like a domain expert, not a generic helper.
3. **Core Behaviors** — 5-8 specific, actionable rules for how this agent operates in its domain. Reference real workflows (e.g., for email: triage → draft → follow-up tracking).
4. **Communication Style** — How this agent reports back to the main agent. Terse status updates? Detailed briefs? Depends on the domain.
5. **What I Don't Do** — Clear boundaries. Tasks outside this domain get routed back to main.
6. **Quality Standards** — What "good work" looks like in this domain.

## AGENTS.md Guidelines:
This defines HOW this sub-agent operates — behavioral rules and workflows. Include:
1. **Workflow** — Step-by-step process for the most common task in this domain
2. **Prioritization** — How to triage and order work within this domain
3. **Escalation Rules** — When to punt back to the main agent
4. **Output Formats** — Default format for deliverables in this domain
5. **Tool Preferences** — Which tools to prefer for domain tasks

# Output Format

Output the two files separated by these exact markers:
---SOUL.MD---
[SOUL.md content]
---AGENTS.MD---
[AGENTS.md content]

Generate both files now. Make them specific to ${agent.displayName}'s domain.`;

  const responseText = await callOpenRouter(
    apiKey,
    'anthropic/claude-opus-4.6',
    [{ role: 'user', content: prompt }],
    3000
  );

  const soulMatch = responseText.match(/---SOUL\.MD---([\s\S]*?)---AGENTS\.MD---/);
  const agentsMatch = responseText.match(/---AGENTS\.MD---([\s\S]*?)$/);

  if (!soulMatch) {
    throw new Error(`Failed to parse sub-agent response for ${agent.name}`);
  }

  return {
    soulMd: soulMatch[1].trim(),
    agentsMd: (agentsMatch ? agentsMatch[1].trim() : '')
  };
}
```

**Step 2: Add templated HEARTBEAT.md for sub-agents**

```javascript
function generateSubAgentHeartbeat(agent, usage) {
  const frequency = {
    high: 'Active — check every 30-60 min',
    medium: 'Moderate — check 3x/day',
    low: 'Light — check 1x/day',
    minimal: 'Weekly summary only'
  }[usage] || 'Moderate — check 3x/day';

  return `# HEARTBEAT.md — ${agent.displayName} ${agent.emoji}

> Domain: ${agent.focus}
> Frequency: ${frequency}

## Heartbeat Checklist

- [ ] Check for pending ${agent.focus.split(',')[0].trim()} tasks
- [ ] Process any queued items in domain
- [ ] Report status to main agent if anything changed

## Rules
1. Only heartbeat on items in your domain: ${agent.focus}
2. Batch updates — one report per heartbeat, not per item
3. Flag blockers immediately, don't wait for next heartbeat
`;
}
```

**Step 3: Rewrite generateSubAgents to use Opus calls in parallel**

Replace the current `generateSubAgents` function. The new version:
1. Selects agents from tags (same logic, cap at 3)
2. Gets the API key
3. Fires parallel Opus calls via `Promise.allSettled`
4. For any that fail, falls back to the existing template generation
5. Attaches heartbeatMd to each agent

```javascript
async function generateSubAgents(quizResults, botName, mainUserMd) {
  const tags = quizResults.tags || [];
  const scores = quizResults.dimensionScores || {};

  const matchedAgents = [];
  for (const tag of tags) {
    if (AGENT_MAP[tag]) {
      matchedAgents.push({ tag, ...AGENT_MAP[tag] });
    }
  }

  const workAgents = matchedAgents.filter(a => a.tag.startsWith('work:'));
  const personalAgents = matchedAgents.filter(a => a.tag.startsWith('personal:'));
  const selected = [...workAgents, ...personalAgents].slice(0, 3);

  if (selected.length === 0) return { agents: [], multiAgentMd: '' };

  // Usage for heartbeat frequency
  const usageTag = tags.find(t => t.startsWith('usage:'));
  const usage = usageTag ? usageTag.split(':')[1] : 'medium';

  // Derive personality for template fallback
  const casualness = clamp(1 - (scores.formal_vs_casual || 0.5), 0, 1);
  const humor = clamp(1 - (scores.serious_vs_playful || 0.5), 0, 1);
  const toneLabel = casualness < 0.45 ? 'formal' : casualness > 0.55 ? 'casual' : 'neutral';

  let apiKey;
  try {
    apiKey = await getApiKey();
  } catch (err) {
    apiKey = null;
  }

  // Fire parallel Opus calls
  const results = await Promise.allSettled(
    selected.map(agent => {
      if (!apiKey) return Promise.reject(new Error('No API key'));
      return generateSubAgentWithClaude(agent, quizResults, botName, apiKey);
    })
  );

  const agents = selected.map((agent, i) => {
    const safeName = agent.name.replace(/[^a-zA-Z0-9-]/g, '');
    if (!safeName || safeName !== agent.name) {
      throw new Error(`Invalid agent name: ${agent.name}`);
    }

    let soulMd, agentsMd;

    if (results[i].status === 'fulfilled') {
      soulMd = results[i].value.soulMd;
      agentsMd = results[i].value.agentsMd;
      console.log(`Sub-agent ${agent.name}: Opus generation succeeded`);
    } else {
      // Fallback to template
      console.error(`Sub-agent ${agent.name}: Opus failed (${results[i].reason.message}), using template`);
      soulMd = generateTemplateSubAgentSoul(agent, botName, toneLabel, humor, casualness);
      agentsMd = generateTemplateSubAgentAgents(agent);
    }

    return {
      name: safeName,
      displayName: agent.displayName,
      emoji: agent.emoji,
      tag: agent.tag,
      soulMd,
      agentsMd,
      heartbeatMd: generateSubAgentHeartbeat(agent, usage),
      userMd: mainUserMd
    };
  });

  // Generate MULTI-AGENT.md (same as before)
  const multiAgentMd = `# Multi-Agent Team
...same as current...`;

  return { agents, multiAgentMd };
}
```

**Step 4: Extract template fallback functions**

Move the existing template SOUL.md generation into `generateTemplateSubAgentSoul()` (same logic as current `generateSubAgents` inline template). Add a new `generateTemplateSubAgentAgents()`:

```javascript
function generateTemplateSubAgentSoul(agent, botName, toneLabel, humor, casualness) {
  // Same template as current generateSubAgents inline SOUL.md
  return `# SOUL.md — ${agent.displayName} ${agent.emoji}

## Role
I'm a specialized sub-agent of ${botName}, focused on: ${agent.focus}.
...rest of current template...`;
}

function generateTemplateSubAgentAgents(agent) {
  return `# Agent Operations — ${agent.displayName}

## Workflow
1. Receive task from main agent
2. Execute within domain: ${agent.focus}
3. Report results back to main agent

## Escalation Rules
- Tasks outside domain: route to main agent
- Ambiguous requests: ask main agent for clarification
- Errors: report with context and suggested next steps

## Output Format
- Status updates: one-line summary
- Deliverables: structured markdown
`;
}
```

**Step 5: Update generateProfile to pass mainUserMd**

```javascript
async function generateProfile(quizResults, username, botName) {
  let result;
  try {
    result = await generateWithClaude(quizResults, username, botName);
  } catch (err) {
    console.error('Claude API generation failed, using fallback:', err.message);
    result = generateFallback(quizResults, username, botName);
  }

  const { agents, multiAgentMd } = await generateSubAgents(quizResults, botName, result.userMd);

  return { ...result, agents, multiAgentMd };
}
```

**Step 6: Increase callOpenRouter timeout for sub-agents**

The existing timeout is 60s. Sub-agent calls are smaller (3000 tokens vs 8000) so 60s should be fine, but add a timeout parameter to `callOpenRouter`:

```javascript
function callOpenRouter(apiKey, model, messages, maxTokens, timeoutMs) {
  // ...existing...
  req.setTimeout(timeoutMs || 120000, () => { ... });
  // ...
}
```

Update the main call to use 120000 (2 min) and sub-agent calls use 60000. Also bump main call max_tokens from 8000 to 15000 (6 files now instead of 5).

---

### Task 3: Update file deployment to handle new files + restart container

**Files:**
- Modify: `api/onboarding-server.js:211-342` (deployFilesToInstance)

**Step 1: Write new files locally**

After writing the existing files, add AGENTS.md for main agent:

```javascript
if (record.generatedFiles.agentsMd) {
  await fs.writeFile(path.join(outputDir, 'AGENTS.md'), record.generatedFiles.agentsMd, 'utf8');
}
```

For each sub-agent, write all four files (SOUL.md, AGENTS.md, HEARTBEAT.md, USER.md):

```javascript
if (record.generatedFiles.agents && record.generatedFiles.agents.length > 0) {
  for (const agent of record.generatedFiles.agents) {
    const agentDir = path.join(outputDir, 'agents', agent.name);
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'SOUL.md'), agent.soulMd, 'utf8');
    if (agent.agentsMd) await fs.writeFile(path.join(agentDir, 'AGENTS.md'), agent.agentsMd, 'utf8');
    if (agent.heartbeatMd) await fs.writeFile(path.join(agentDir, 'HEARTBEAT.md'), agent.heartbeatMd, 'utf8');
    if (agent.userMd) await fs.writeFile(path.join(agentDir, 'USER.md'), agent.userMd, 'utf8');
  }
}
```

**Step 2: SCP new files**

Add AGENTS.md to the main file SCP list. For sub-agents, SCP all four files:

```javascript
// Main AGENTS.md
if (record.generatedFiles.agentsMd) {
  await execFileAsync('scp', [...scpOpts, path.join(outputDir, 'AGENTS.md'), `${remoteBase}/AGENTS.md`]);
}

// Sub-agent files
for (const agent of (record.generatedFiles.agents || [])) {
  for (const filename of ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'USER.md']) {
    const localPath = path.join(outputDir, 'agents', agent.name, filename);
    try {
      await fs.access(localPath);
      await execFileAsync('scp', [...scpOpts, localPath, `ubuntu@${record.serverIp}:/home/ubuntu/clawd/agents/${agent.name}/${filename}`]);
    } catch (e) { /* file doesn't exist, skip */ }
  }
}
```

**Step 3: Update chmod paths**

Add AGENTS.md and all sub-agent files to the chmod command.

**Step 4: Restart Docker container after SCP**

After chmod and before token retrieval, restart the container so the entrypoint rediscovers agents:

```javascript
try {
  await execFileAsync('ssh', [
    '-i', record.sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=30',
    `ubuntu@${record.serverIp}`,
    'sudo docker restart openclaw'
  ]);
  // Wait for gateway to fully initialize before reading token
  await new Promise(resolve => setTimeout(resolve, 15000));
} catch (restartErr) {
  console.error(`Container restart failed for ${sessionId}: ${restartErr.message}`);
}
```

---

### Task 4: Add agent discovery to container entrypoint

**Files:**
- Modify: `docker/entrypoint.sh` (add discovery before OpenClaw startup)

**Step 1: Add agent discovery function**

Insert before the `# --- Start OpenClaw ---` section. This runs on EVERY boot (not gated by INIT_MARKER):

```bash
# --- Discover and register sub-agents ---
echo "🔍 Discovering sub-agents..."

AGENT_DIRS=$(find "${WORKSPACE}/agents" -mindepth 1 -maxdepth 1 -type d 2>/dev/null || true)

if [[ -n "${AGENT_DIRS}" ]]; then
    # Build agent list and register in openclaw.json
    MODEL="${MODEL}" WORKSPACE="${WORKSPACE}" CONFIG_DIR="${CONFIG_DIR}" node -e "
      const fs = require('fs');
      const path = require('path');
      const cfgPath = process.argv[1];
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const workspace = process.env.WORKSPACE;
      const configDir = process.env.CONFIG_DIR;
      const model = process.env.MODEL;

      // Discover agent directories
      const agentsDir = path.join(workspace, 'agents');
      let agentNames = [];
      try {
        agentNames = fs.readdirSync(agentsDir).filter(name => {
          const stat = fs.statSync(path.join(agentsDir, name));
          return stat.isDirectory() && /^[a-zA-Z0-9-]+$/.test(name);
        });
      } catch (e) {}

      // Build agents config
      if (!cfg.agents) cfg.agents = {};
      cfg.agents.skipBootstrap = true;

      const list = [
        { id: 'main', default: true, workspace: workspace, model: { primary: model } }
      ];

      for (const name of agentNames) {
        list.push({
          id: name,
          workspace: path.join(workspace, 'agents', name),
          model: { primary: model }
        });

        // Create config directory and copy auth from main
        const agentConfigDir = path.join(configDir, 'agents', name, 'agent');
        fs.mkdirSync(agentConfigDir, { recursive: true });

        const mainAuth = path.join(configDir, 'agents', 'main', 'agent', 'auth-profiles.json');
        const agentAuth = path.join(agentConfigDir, 'auth-profiles.json');
        if (fs.existsSync(mainAuth)) {
          fs.copyFileSync(mainAuth, agentAuth);
        }

        // Create sessions directory
        const sessionsDir = path.join(configDir, 'agents', name, 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        const sessionsFile = path.join(sessionsDir, 'sessions.json');
        if (!fs.existsSync(sessionsFile)) {
          fs.writeFileSync(sessionsFile, '{}');
        }
      }

      cfg.agents.list = list;

      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
      console.log('   Registered agents: main' + (agentNames.length > 0 ? ', ' + agentNames.join(', ') : ''));
    " "${CONFIG_DIR}/openclaw.json"
else
    echo "   No sub-agents found"
fi

chown -R clawd:clawd "${CONFIG_DIR}"
```

**Key behaviors:**
- Runs every boot (not gated by first-boot marker)
- Discovers directories under `${WORKSPACE}/agents/`
- Validates directory names (alphanumeric + hyphen only)
- Adds `agents.list` to openclaw.json with main + discovered agents
- Creates per-agent config dirs under `${CONFIG_DIR}/agents/<name>/`
- Copies `auth-profiles.json` from main to each sub-agent
- Creates empty sessions file for each sub-agent

---

### Task 5: Update generatedFiles storage shape in onboarding-server

**Files:**
- Modify: `api/onboarding-server.js:808-873` (generate-profile endpoint)
- Modify: `api/onboarding-server.js:828-837` (cache check file list)

**Step 1: Update the cache check to include new files**

```javascript
if (record.generatedFiles && record.generatedFiles.soulMd) {
  const fileList = ['SOUL.md', 'USER.md', 'IDENTITY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md'];
  if (record.generatedFiles.agentsMd) fileList.push('AGENTS.md');
  if (record.generatedFiles.agents && record.generatedFiles.agents.length > 0) {
    fileList.push('MULTI-AGENT.md');
    for (const agent of record.generatedFiles.agents) {
      fileList.push(`agents/${agent.name}/SOUL.md`);
      fileList.push(`agents/${agent.name}/AGENTS.md`);
      fileList.push(`agents/${agent.name}/HEARTBEAT.md`);
      fileList.push(`agents/${agent.name}/USER.md`);
    }
  }
  return res.json({ ok: true, files: fileList, cached: true });
}
```

**Step 2: Update the response file list after generation**

Same pattern — include all new files in the response.

---

### Task 6: Commit and verify

**Step 1: Run a local syntax check**

```bash
node -c api/lib/profile-generator.js
node -c api/onboarding-server.js
bash -n docker/entrypoint.sh
```

**Step 2: Commit**

```bash
git add api/lib/profile-generator.js api/onboarding-server.js docker/entrypoint.sh
git commit -m "feat: Opus-quality sub-agent profiles + container agent discovery

- Main agent Opus call now generates AGENTS.md (behavioral instructions)
- Each sub-agent gets individual Opus API call for SOUL.md + AGENTS.md
- Sub-agent calls run in parallel, fall back to template on failure
- Sub-agents get templated HEARTBEAT.md + copy of main USER.md
- deployFilesToInstance SCPs all sub-agent files + restarts container
- Entrypoint discovers agents/*/ dirs on every boot, registers in openclaw.json
- Agent config dirs created with copied auth-profiles.json"
```

---

## Dependency Graph

```
Task 1 (AGENTS.md in main Opus call)
  └─ no deps
Task 2 (sub-agent Opus calls)
  └─ depends on Task 1 (needs agentsMd in return shape)
Task 3 (deployment updates)
  └─ depends on Task 2 (needs new agent file shape)
Task 4 (entrypoint discovery)
  └─ no deps (can be done in parallel with Tasks 1-3)
Task 5 (storage shape updates)
  └─ depends on Tasks 1-2
Task 6 (verify + commit)
  └─ depends on all above
```

Tasks 1+4 can run in parallel. Then 2, then 3+5, then 6.
