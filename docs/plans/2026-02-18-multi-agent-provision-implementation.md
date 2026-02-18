# Multi-Agent Provisioning Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make sub-agents work end-to-end — Opus-quality SOUL.md/AGENTS.md generation, proper file layout, OpenClaw registration, auth propagation.

**Architecture:** Profile generator adds AGENTS.md to main Opus call and replaces template sub-agents with parallel Opus calls. Entrypoint scans workspace `agents/*/` on boot to build `agents.list` and copy auth. SCP deployment adds new files and restarts the container so the entrypoint re-discovers agents.

**Tech Stack:** Node.js (CommonJS), Bash, OpenRouter API (Opus), SSH/SCP

**Design doc:** `docs/plans/2026-02-18-multi-agent-provision-design.md`

---

### Task 1: Create feature branch

**Step 1: Create branch from master**

```bash
git checkout master && git pull
git checkout -b feat/multi-agent-provision
```

**Step 2: Verify branch**

```bash
git branch --show-current
```

Expected: `feat/multi-agent-provision`

---

### Task 2: Add AGENTS.md to main Opus call

**Files:**
- Modify: `api/lib/profile-generator.js`

**Step 1: Add timeout parameter to `callOpenRouter()`**

At line 49, change the function signature:

```javascript
// Before:
function callOpenRouter(apiKey, model, messages, maxTokens) {

// After:
function callOpenRouter(apiKey, model, messages, maxTokens, timeout = 120000) {
```

At line 82, use the parameter:

```javascript
// Before:
req.setTimeout(60000, () => { req.destroy(); reject(new Error('OpenRouter request timed out')); });

// After:
req.setTimeout(timeout, () => { req.destroy(); reject(new Error('OpenRouter request timed out')); });
```

**Step 2: Add AGENTS.md guidelines to the main Opus prompt**

In `generateWithClaude()`, insert after the BOOTSTRAP.md guidelines (after line 243, before the closing backtick of the prompt template) and before the `# Output Format` section:

```javascript
## AGENTS.md Guidelines:
This defines HOW the assistant operates — behavioral rules, working protocols, and delegation logic. Where SOUL.md defines who the assistant IS, AGENTS.md defines what the assistant DOES.

Structure it like this:

1. **Operating Protocol** — Step-by-step workflow for handling incoming requests:
   - Assess: What type of task? (quick question, deep work, research, creative, emotional)
   - Categorize: Handle directly or delegate to a sub-agent?
   - Act: Execute or delegate with a crisp brief
   - Deliver: Synthesize and present in the user's preferred style

2. **Response Protocols** — How to handle each request type:
   - Quick question: answer directly, cite source if non-obvious
   - Deep work: outline approach, confirm, execute
   - Research: delegate to research agent if available, otherwise structured research
   - Creative: match user's creativity dial from SOUL.md
   - Emotional: match user's emotional register from SOUL.md

3. **Proactive Behaviors** — Things to do without being asked:
   - Run heartbeat checks per HEARTBEAT.md schedule
   - Follow up on open items from previous conversations
   - Detect patterns across conversations (recurring topics, frustrations, goals)

4. **Quality Standards**:
   - State confidence level on factual claims
   - Cite sources for non-obvious facts
   - Flag when operating at knowledge boundary
   - Match output format to context (code blocks for code, structured for analysis, conversational for casual)

5. **Boundaries** — Things to NEVER do without explicit user approval:
   - Send messages or emails on user's behalf
   - Make financial transactions or commitments
   - Delete or modify important documents
   - Share user's personal information with third parties

Incorporate the user's specific quiz results: if they want high challenge, include rules about proactive pushback. If they're high proactivity, include rules about when to take initiative.
```

**Step 3: Update the output format section in the prompt**

Replace the output format section (around line 249):

```javascript
// Before:
---BOOTSTRAP.MD---
[BOOTSTRAP.md content here]

// After:
---BOOTSTRAP.MD---
[BOOTSTRAP.md content here]
---AGENTS.MD---
[AGENTS.md content here]
```

And update the instruction to say "six" instead of "five":

```javascript
// Before:
Generate all five files now.

// After:
Generate all six files now.
```

**Step 4: Bump max_tokens**

At line 268 (the `callOpenRouter` call):

```javascript
// Before:
const responseText = await callOpenRouter(
  apiKey,
  'anthropic/claude-opus-4.6',
  [{ role: 'user', content: prompt }],
  8000
);

// After:
const responseText = await callOpenRouter(
  apiKey,
  'anthropic/claude-opus-4.6',
  [{ role: 'user', content: prompt }],
  10000
);
```

**Step 5: Update response parsing**

Replace the parsing block (lines 271-276):

```javascript
// Before:
const bootstrapMatch = responseText.match(/---BOOTSTRAP\.MD---([\s\S]*?)$/);

// After:
const bootstrapMatch = responseText.match(/---BOOTSTRAP\.MD---([\s\S]*?)---AGENTS\.MD---/);
const agentsMatch = responseText.match(/---AGENTS\.MD---([\s\S]*?)$/);
```

**Step 6: Update return object**

Replace the return statement (lines 281-287):

```javascript
// Before:
return {
  soulMd: soulMatch[1].trim(),
  userMd: userMatch[1].trim(),
  identityMd: identityMatch[1].trim(),
  heartbeatMd: (heartbeatMatch ? heartbeatMatch[1].trim() : ''),
  bootstrapMd: (bootstrapMatch ? bootstrapMatch[1].trim() : '')
};

// After:
return {
  soulMd: soulMatch[1].trim(),
  userMd: userMatch[1].trim(),
  identityMd: identityMatch[1].trim(),
  heartbeatMd: (heartbeatMatch ? heartbeatMatch[1].trim() : ''),
  bootstrapMd: (bootstrapMatch ? bootstrapMatch[1].trim() : ''),
  agentsMd: (agentsMatch ? agentsMatch[1].trim() : '')
};
```

**Step 7: Update fallback to include empty agentsMd**

In `generateFallback()`, update the return (around line 541):

```javascript
// Before:
return { soulMd, userMd, identityMd, heartbeatMd, bootstrapMd };

// After:
return { soulMd, userMd, identityMd, heartbeatMd, bootstrapMd, agentsMd: '' };
```

**Step 8: Commit**

```bash
git add api/lib/profile-generator.js
git commit -m "feat: add AGENTS.md to main Opus profile generation"
```

---

### Task 3: Opus-based sub-agent generation

**Files:**
- Modify: `api/lib/profile-generator.js`

**Step 1: Add `generateSubAgentWithClaude()` function**

Insert after the existing `generateAgentBehaviors()` function (after line 573):

```javascript
// Generate SOUL.md + AGENTS.md for a single sub-agent via Opus
async function generateSubAgentWithClaude(apiKey, agent, mainSoulMd, mainUserMd, quizResults, botName) {
  const prompt = `You are generating personalized configuration files for a ClawDaddy AI sub-agent.

This sub-agent is part of a multi-agent team led by ${botName}. The main agent handles direct user interaction and delegates specialized tasks to sub-agents.

# Main Agent Context

## Main Agent Personality (SOUL.md):
${mainSoulMd}

## User Profile (USER.md):
${mainUserMd}

# Sub-Agent Definition
- Name: ${agent.displayName} ${agent.emoji}
- Internal ID: ${agent.name}
- Domain: ${agent.focus}

# Your Task

Generate two files for this sub-agent. Make them deeply specific to this domain and coherent with the main agent's personality and the user's preferences.

## SOUL.md Guidelines:
Define WHO this sub-agent is — personality, communication style, domain expertise.

1. **Role summary** — 2-3 sentences: what this agent does, its relationship to ${botName}, why it exists.
2. **Personality** — Inherit core traits from the main agent (tone, humor, formality) but adapt for the domain. A data analyst might be more precise; a writing agent more creative; an ops agent more terse.
3. **Domain Expertise** — Deep description of skills, knowledge, and operating style specific to this domain. Not generic — reference the actual tools, workflows, and deliverables of this specialty.
4. **Communication Style** — How this agent delivers results to the main agent. Match the user's preferences for verbosity, structure, and detail.
5. **Core Behaviors** — 5-8 specific behavioral rules for common tasks in this domain.
6. **What I Don't Do** — Clear boundaries. Tasks outside domain route back to main agent. Never interact with user directly — all communication goes through ${botName}.

## AGENTS.md Guidelines:
Define WHAT this sub-agent does — operational workflows, quality standards, escalation rules.

1. **Standard Workflows** — Step-by-step procedures for the 3-5 most common tasks in this domain.
2. **Output Formats** — Default templates or structures for deliverables in this domain.
3. **Escalation Rules** — When to handle independently vs send back to main agent with context.
4. **Quality Standards** — Domain-specific validation checks before delivering results.
5. **Heartbeat Duties** — What to check or do during scheduled heartbeat cycles.

# Output Format

Output the two files separated by these exact markers (markers must appear on their own line):
---SOUL.MD---
[SOUL.md content]
---AGENTS.MD---
[AGENTS.md content]

Generate both files now. Make them specific to the ${agent.focus} domain and this user's preferences.`;

  const responseText = await callOpenRouter(
    apiKey,
    'anthropic/claude-opus-4.6',
    [{ role: 'user', content: prompt }],
    4000
  );

  const soulMatch = responseText.match(/---SOUL\.MD---([\s\S]*?)---AGENTS\.MD---/);
  const agentsMatch = responseText.match(/---AGENTS\.MD---([\s\S]*?)$/);

  if (!soulMatch) {
    throw new Error(`Failed to parse sub-agent ${agent.name} response — missing SOUL.MD marker`);
  }

  return {
    soulMd: soulMatch[1].trim(),
    agentsMd: (agentsMatch ? agentsMatch[1].trim() : '')
  };
}
```

**Step 2: Add `generateSubAgentHeartbeat()` function**

Insert after the new function:

```javascript
// Generate templated HEARTBEAT.md for a sub-agent based on their domain tag
function generateSubAgentHeartbeat(agent, quizResults) {
  const tags = quizResults.tags || [];
  const usageTag = tags.find(t => t.startsWith('usage:'));
  const usage = usageTag ? usageTag.split(':')[1] : 'medium';

  const HEARTBEAT_CHECKS = {
    'work:email': '- [ ] **Email triage** \u2014 Scan inbox, categorize urgent/draft-ready/FYI/archive, draft routine replies',
    'work:research': '- [ ] **Research digest** \u2014 Surface relevant articles, competitive intel, trend updates',
    'work:data_analysis': '- [ ] **Metrics check** \u2014 Monitor dashboards, flag anomalies (>2\u03C3), update trend reports',
    'work:writing': '- [ ] **Writing projects** \u2014 Check active drafts, deadline status, pending reviews',
    'work:project_management': '- [ ] **Project pulse** \u2014 Surface blockers, overdue tasks, upcoming milestones, standup prep',
    'work:coding': '- [ ] **Code review queue** \u2014 Check PRs, CI status, open issues, stale branches',
    'personal:finance': '- [ ] **Finance check** \u2014 Bill reminders, budget vs actual, unusual transactions',
    'personal:health': '- [ ] **Health nudge** \u2014 Medication/supplement reminders, activity tracking, wellness check-in'
  };

  const check = HEARTBEAT_CHECKS[agent.tag] || '- [ ] **Domain check** \u2014 Monitor status, surface actionable items';

  let frequency;
  if (usage === 'high') frequency = 'Active heartbeats, 3-5x/day';
  else if (usage === 'medium') frequency = 'Moderate heartbeats, 2-3x/day';
  else if (usage === 'low') frequency = 'Light heartbeats, 1x/day';
  else frequency = 'Weekly summary only';

  return `# HEARTBEAT.md \u2014 ${agent.displayName} ${agent.emoji}

> Usage level: ${usage.toUpperCase()} \u2192 ${frequency}
> Domain: ${agent.focus}

---

## Heartbeat Checklist

${check}

---

## Heartbeat Behavior Rules

1. Every heartbeat delivers info or takes action. "All quiet" is one line, not a paragraph.
2. Report results to main agent, never directly to user.
3. Be opinionated \u2014 triage and prioritize, don't just list.
4. Flag items needing main agent's judgment with one-line context.
`;
}
```

**Step 3: Replace `generateSubAgents()` with `generateSubAgentsWithClaude()`**

Replace the entire `generateSubAgents()` function (lines 576-659) with:

```javascript
// Generate sub-agents with Opus API calls (parallel)
async function generateSubAgentsWithClaude(quizResults, botName, mainResult) {
  const tags = quizResults.tags || [];

  // Find matching agents from tags
  const matchedAgents = [];
  for (const tag of tags) {
    if (AGENT_MAP[tag]) {
      matchedAgents.push({ tag, ...AGENT_MAP[tag] });
    }
  }

  // Cap at 3 sub-agents (work tags first, then personal)
  const workAgents = matchedAgents.filter(a => a.tag.startsWith('work:'));
  const personalAgents = matchedAgents.filter(a => a.tag.startsWith('personal:'));
  const selected = [...workAgents, ...personalAgents].slice(0, 3);

  if (selected.length === 0) return { agents: [], multiAgentMd: '' };

  const apiKey = await getApiKey();

  // Generate all sub-agents in parallel via Opus
  const agentResults = await Promise.all(
    selected.map(async (agent) => {
      // Validate agent name
      const safeName = agent.name.replace(/[^a-zA-Z0-9-]/g, '');
      if (!safeName || safeName !== agent.name) {
        throw new Error(`Invalid agent name: ${agent.name}`);
      }

      try {
        const { soulMd, agentsMd } = await generateSubAgentWithClaude(
          apiKey, agent, mainResult.soulMd, mainResult.userMd, quizResults, botName
        );
        const heartbeatMd = generateSubAgentHeartbeat(agent, quizResults);

        return {
          name: safeName,
          displayName: agent.displayName,
          emoji: agent.emoji,
          tag: agent.tag,
          soulMd,
          agentsMd,
          heartbeatMd
        };
      } catch (err) {
        console.error(`Sub-agent ${agent.name} Opus generation failed: ${err.message}`);
        return null;
      }
    })
  );

  const agents = agentResults.filter(Boolean);
  if (agents.length === 0) return { agents: [], multiAgentMd: '' };

  // Generate MULTI-AGENT.md summary
  const multiAgentMd = `# Multi-Agent Team

> Generated from ClawDaddy onboarding quiz
> ${agents.length} sub-agent${agents.length > 1 ? 's' : ''} configured

## Team Structure

**Main Agent (${botName})** \u2014 Primary interface, delegates to specialists.

${agents.map(a => `### ${a.displayName} ${a.emoji}
- **Domain:** ${AGENT_MAP[a.tag].focus}
- **Directory:** agents/${a.name}/`).join('\n\n')}

## Delegation Protocol
1. User interacts with main agent only
2. Main agent delegates domain tasks to sub-agents
3. Sub-agents return results to main agent
4. Main agent synthesizes and delivers to user
`;

  return { agents, multiAgentMd };
}
```

**Step 4: Update `generateProfile()` to use new sub-agent generation**

Replace the entire `generateProfile()` function (lines 662-677):

```javascript
async function generateProfile(quizResults, username, botName) {
  let mainResult;
  let useFallback = false;

  try {
    mainResult = await generateWithClaude(quizResults, username, botName);
  } catch (err) {
    console.error('Claude API generation failed, using fallback:', err.message);
    useFallback = true;
    mainResult = generateFallback(quizResults, username, botName);
  }

  // Sub-agents require Opus — skip if main API failed
  let agents = [];
  let multiAgentMd = '';

  if (!useFallback) {
    try {
      const subResult = await generateSubAgentsWithClaude(quizResults, botName, mainResult);
      agents = subResult.agents;
      multiAgentMd = subResult.multiAgentMd;
    } catch (err) {
      console.error('Sub-agent generation failed:', err.message);
    }
  }

  return { ...mainResult, agents, multiAgentMd };
}
```

**Step 5: Remove dead code**

Delete the now-unused `generateAgentBehaviors()` function (lines 545-573) and the old `generateSubAgents()` function (replaced in step 3).

**Step 6: Commit**

```bash
git add api/lib/profile-generator.js
git commit -m "feat: upgrade sub-agent generation to parallel Opus API calls"
```

---

### Task 4: Update SCP deployment for multi-agent file layout

**Files:**
- Modify: `api/onboarding-server.js`

**Step 1: Update local file writes in `deployFilesToInstance()`**

After line 237 (writing BOOTSTRAP.md), add AGENTS.md:

```javascript
await fs.writeFile(path.join(outputDir, 'AGENTS.md'), record.generatedFiles.agentsMd || '', 'utf8');
```

**Step 2: Update sub-agent local file writes**

Replace the sub-agent file write block (lines 243-249) to include new files:

```javascript
if (record.generatedFiles.agents && record.generatedFiles.agents.length > 0) {
  for (const agent of record.generatedFiles.agents) {
    const agentDir = path.join(outputDir, 'agents', agent.name);
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'SOUL.md'), agent.soulMd, 'utf8');
    await fs.writeFile(path.join(agentDir, 'AGENTS.md'), agent.agentsMd || '', 'utf8');
    await fs.writeFile(path.join(agentDir, 'HEARTBEAT.md'), agent.heartbeatMd || '', 'utf8');
    // Copy main USER.md to sub-agent directory
    await fs.writeFile(path.join(agentDir, 'USER.md'), record.generatedFiles.userMd, 'utf8');
  }
}
```

**Step 3: Update SCP of main files**

In the SCP loop (around line 265), add AGENTS.md to the filename list:

```javascript
// Before:
for (const filename of ['SOUL.md', 'USER.md', 'IDENTITY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md']) {

// After:
for (const filename of ['SOUL.md', 'USER.md', 'IDENTITY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md', 'AGENTS.md']) {
```

**Step 4: Update sub-agent SCP**

Replace the sub-agent SCP block (lines 273-283) to transfer all files:

```javascript
if (record.generatedFiles.agents && record.generatedFiles.agents.length > 0) {
  // Create all sub-agent directories in one SSH call
  await execFileAsync('ssh', [
    '-i', record.sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=30',
    `ubuntu@${record.serverIp}`,
    'mkdir -p ' + record.generatedFiles.agents.map(a => `/home/ubuntu/clawd/agents/${a.name}`).join(' ')
  ]);

  // SCP all files for each sub-agent
  for (const agent of record.generatedFiles.agents) {
    for (const filename of ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'USER.md']) {
      const localPath = path.join(outputDir, 'agents', agent.name, filename);
      await execFileAsync('scp', [
        ...scpOpts, localPath,
        `ubuntu@${record.serverIp}:/home/ubuntu/clawd/agents/${agent.name}/${filename}`
      ]);
    }
  }
}
```

**Step 5: Update chmod paths**

Replace the chmod block (lines 286-299) to include new files:

```javascript
let chmodPaths = '/home/ubuntu/clawd/SOUL.md /home/ubuntu/clawd/USER.md /home/ubuntu/clawd/IDENTITY.md /home/ubuntu/clawd/HEARTBEAT.md /home/ubuntu/clawd/BOOTSTRAP.md /home/ubuntu/clawd/AGENTS.md';
if (record.generatedFiles.multiAgentMd) {
  chmodPaths += ' /home/ubuntu/clawd/MULTI-AGENT.md';
}
if (record.generatedFiles.agents && record.generatedFiles.agents.length > 0) {
  for (const agent of record.generatedFiles.agents) {
    for (const f of ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'USER.md']) {
      chmodPaths += ` /home/ubuntu/clawd/agents/${agent.name}/${f}`;
    }
  }
}
```

**Step 6: Add container restart after file deployment**

After the chmod SSH call (around line 300) and BEFORE the gateway token read, add:

```javascript
// Restart container so entrypoint re-discovers agents and rebuilds config
try {
  await execFileAsync('ssh', [
    '-i', record.sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=30',
    `ubuntu@${record.serverIp}`,
    'sudo docker restart openclaw && sleep 15'
  ], { timeout: 60000 });
  console.log(`Container restarted for ${sessionId} to register agents`);
} catch (restartErr) {
  console.error(`Container restart failed for ${sessionId}: ${restartErr.message}`);
  // Non-fatal — agents will register on next natural restart
}
```

**Step 7: Update the generate-profile endpoint's file list**

In the `/api/onboarding/generate-profile/:sessionId` handler (around line 845), update the file list:

```javascript
// Before:
const fileList = ['SOUL.md', 'USER.md', 'IDENTITY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md'];
if (agents && agents.length > 0) {
  fileList.push('MULTI-AGENT.md');
  for (const agent of agents) {
    fileList.push(`agents/${agent.name}/SOUL.md`);
  }
}

// After:
const fileList = ['SOUL.md', 'USER.md', 'IDENTITY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md', 'AGENTS.md'];
if (agents && agents.length > 0) {
  fileList.push('MULTI-AGENT.md');
  for (const agent of agents) {
    fileList.push(`agents/${agent.name}/SOUL.md`);
    fileList.push(`agents/${agent.name}/AGENTS.md`);
    fileList.push(`agents/${agent.name}/HEARTBEAT.md`);
    fileList.push(`agents/${agent.name}/USER.md`);
  }
}
```

Also update the cached file list in the early-return block (around line 816):

```javascript
// Before:
if (record.generatedFiles.agents && record.generatedFiles.agents.length > 0) {
  fileList.push('MULTI-AGENT.md');
  for (const agent of record.generatedFiles.agents) {
    fileList.push(`agents/${agent.name}/SOUL.md`);
  }
}

// After:
if (record.generatedFiles.agents && record.generatedFiles.agents.length > 0) {
  fileList.push('MULTI-AGENT.md');
  for (const agent of record.generatedFiles.agents) {
    fileList.push(`agents/${agent.name}/SOUL.md`);
    fileList.push(`agents/${agent.name}/AGENTS.md`);
    fileList.push(`agents/${agent.name}/HEARTBEAT.md`);
    fileList.push(`agents/${agent.name}/USER.md`);
  }
}
```

**Step 8: Commit**

```bash
git add api/onboarding-server.js
git commit -m "feat: update SCP deployment for multi-agent file layout"
```

---

### Task 5: Add agent discovery and registration to Docker entrypoint

**Files:**
- Modify: `docker/entrypoint.sh`

**Step 1: Add agent discovery before config write**

Insert after the channels-building block (after line 67, before the `# Write main config` comment at line 69):

```bash
# --- Discover sub-agents from workspace ---
echo "🔍 Scanning for sub-agents..."

AGENTS_LIST=$(WORKSPACE="${WORKSPACE}" MODEL="${MODEL}" node -e "
  const fs = require('fs');
  const path = require('path');
  const ws = process.env.WORKSPACE;
  const model = process.env.MODEL;
  const list = [{ id: 'main', 'default': true, workspace: ws, model: { primary: model } }];
  const agentsDir = path.join(ws, 'agents');
  try {
    for (const name of fs.readdirSync(agentsDir)) {
      if (!/^[a-zA-Z0-9-]+$/.test(name)) continue;
      const p = path.join(agentsDir, name);
      if (!fs.statSync(p).isDirectory()) continue;
      list.push({ id: name, workspace: p, model: { primary: model } });
    }
  } catch (e) {}
  console.log(JSON.stringify(list));
")

SUB_AGENT_COUNT=$(echo "${AGENTS_LIST}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).length-1))")
echo "   Found ${SUB_AGENT_COUNT} sub-agent(s)"
```

**Step 2: Update the openclaw.json heredoc to include agents.list**

Replace the `"agents"` block in the heredoc (lines ~80-88):

```bash
# Before:
  "agents": {
    "defaults": {
      "model": {
        "primary": "${MODEL}"
      },
      "workspace": "${WORKSPACE}",
      "userTimezone": "${TZ:-America/New_York}"
    }
  },

# After:
  "agents": {
    "defaults": {
      "model": {
        "primary": "${MODEL}"
      },
      "workspace": "${WORKSPACE}",
      "userTimezone": "${TZ:-America/New_York}"
    },
    "skipBootstrap": true,
    "list": ${AGENTS_LIST}
  },
```

**Step 3: Add sub-agent config directory creation**

Insert after writing main auth-profiles.json (after line 125):

```bash
# --- Set up sub-agent config directories ---
for agent_dir in "${WORKSPACE}/agents"/*/; do
    [ -d "${agent_dir}" ] || continue
    agent_name=$(basename "${agent_dir}")
    [[ "${agent_name}" =~ ^[a-zA-Z0-9-]+$ ]] || continue

    mkdir -p "${CONFIG_DIR}/agents/${agent_name}/agent"
    cp "${CONFIG_DIR}/agents/main/agent/auth-profiles.json" \
       "${CONFIG_DIR}/agents/${agent_name}/agent/auth-profiles.json"
    mkdir -p "${CONFIG_DIR}/agents/${agent_name}/sessions"
    [[ -f "${CONFIG_DIR}/agents/${agent_name}/sessions/sessions.json" ]] || \
        echo '{}' > "${CONFIG_DIR}/agents/${agent_name}/sessions/sessions.json"

    echo "   ✅ Registered sub-agent: ${agent_name}"
done
```

**Step 4: Verify entrypoint syntax**

```bash
bash -n docker/entrypoint.sh
```

Expected: no output (no syntax errors).

**Step 5: Commit**

```bash
git add docker/entrypoint.sh
git commit -m "feat: add agent discovery and registration to entrypoint"
```

---

### Task 6: Smoke test plan

No automated test framework exists. Verify manually:

**Step 1: Verify profile-generator loads without syntax errors**

```bash
cd api && node -e "const pg = require('./lib/profile-generator'); console.log('Module loaded OK, exports:', Object.keys(pg))"
```

Expected: `Module loaded OK, exports: [ 'generateProfile' ]`

**Step 2: Verify onboarding-server loads without syntax errors**

```bash
cd api && timeout 3 node -e "
  // Override listen to avoid binding port
  const http = require('http');
  const origListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function() { console.log('Server would listen'); process.exit(0); };
  require('./onboarding-server');
" 2>&1 || true
```

Expected: loads without crash (may error on missing secrets file, that's fine).

**Step 3: Verify entrypoint syntax**

```bash
bash -n docker/entrypoint.sh && echo "Entrypoint syntax OK"
```

Expected: `Entrypoint syntax OK`

**Step 4: Final commit with all changes**

```bash
git log --oneline feat/multi-agent-provision ^master
```

Expected: 4 commits:
1. `feat: add AGENTS.md to main Opus profile generation`
2. `feat: upgrade sub-agent generation to parallel Opus API calls`
3. `feat: update SCP deployment for multi-agent file layout`
4. `feat: add agent discovery and registration to entrypoint`

---

### End-to-end verification (on a real instance)

After deploying to the control plane, test with a real onboarding flow:

1. Submit onboarding with quiz results that include work:research + work:email tags
2. Verify profile generation returns AGENTS.md + sub-agent files in the response
3. Verify SCP deploys all files to correct paths on instance
4. Verify container restart triggers entrypoint re-scan
5. SSH into instance, check:
   - `cat /home/ubuntu/clawd/AGENTS.md` exists
   - `ls /home/ubuntu/clawd/agents/` shows sub-agent dirs
   - `sudo docker exec openclaw cat /home/clawd/.openclaw/openclaw.json | python3 -m json.tool` shows agents.list with sub-agents
   - `ls /home/clawd/.openclaw/agents/` (inside container) shows config dirs for each agent
