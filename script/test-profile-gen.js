'use strict';

// ============================================================
// test-profile-gen.js — Dry-run profile generation test
// Usage: node script/test-profile-gen.js
// ============================================================

const fs = require('fs');
const path = require('path');

// --- API key sanity check ---
// The profile-generator reads from /home/ubuntu/clawdaddy/.secrets/anthropic-key,
// but the canonical secrets path for this repo is:
const secretsPath = path.join(__dirname, '..', '..', '.secrets', 'anthropic-key');
// Also check the path the profile-generator actually reads from:
const generatorSecretsPath = '/home/ubuntu/clawdaddy/.secrets/anthropic-key';

const hasEnvKey = !!process.env.ANTHROPIC_API_KEY;
const hasRepoSecret = fs.existsSync(secretsPath);
const hasGeneratorSecret = fs.existsSync(generatorSecretsPath);

if (!hasEnvKey && !hasRepoSecret && !hasGeneratorSecret) {
  console.error(`
ERROR: Anthropic API key not found.

The profile-generator requires one of:
  1. ANTHROPIC_API_KEY environment variable
  2. ${generatorSecretsPath}  ← what profile-generator.js reads
  3. ${secretsPath}  ← this repo's secrets dir

To fix: set ANTHROPIC_API_KEY, or create the secrets file at:
  ${generatorSecretsPath}

Exiting.
`);
  process.exit(1);
}

// Set env key from file if not already set (generator reads file itself, but for clarity)
if (!hasEnvKey) {
  if (hasGeneratorSecret) {
    process.env.ANTHROPIC_API_KEY = fs.readFileSync(generatorSecretsPath, 'utf8').trim();
    console.error('[setup] Loaded API key from', generatorSecretsPath);
  } else if (hasRepoSecret) {
    process.env.ANTHROPIC_API_KEY = fs.readFileSync(secretsPath, 'utf8').trim();
    console.error('[setup] Loaded API key from', secretsPath);
  }
} else {
  console.error('[setup] Using ANTHROPIC_API_KEY from environment');
}

// --- Import profile-generator directly (avoids triggering email.js ESM imports) ---
const { generateProfile } = require('../api/lib/profile-generator');

// --- Synthetic quiz data ---
const quizResults = {
  dimensionScores: {
    organized_vs_spontaneous: 0.72,
    formal_vs_casual: 0.25,
    proactive_vs_reactive: 0.85,
    detailed_vs_big_picture: 0.45,
    serious_vs_playful: 0.35,
    independent_vs_collaborative: 0.60,
    supportive_vs_challenging: 0.30,
    practical_vs_exploratory: 0.40,
    analytical_vs_empathetic: 0.70
  },
  traits: {},
  tags: [
    'work:email',
    'work:coding',
    'work:project_management',
    'personal:finance',
    'usage:high'
  ],
  freeText: {
    'user.preferred_name': 'Alex',
    'user.role': 'Engineering Manager at a mid-stage startup',
    'anything_else': 'I have ADHD so I need help staying on track. I context-switch a lot between IC work and management. Morning person — most productive before noon.'
  },
  perQuestionContext: {}
};

const username = 'alextest';
const botName = 'Spark';

// --- Main ---
console.error('[start] Calling generateProfile — this will make real Anthropic API calls (60-120s)...');

generateProfile(quizResults, username, botName, {
  onProgress: (p) => console.error(`[${p.stage}] ${p.message}`)
})
  .then((result) => {
    // Print main agent files
    const sections = [
      { label: 'SOUL.MD',      content: result.soulMd },
      { label: 'USER.MD',      content: result.userMd },
      { label: 'IDENTITY.MD',  content: result.identityMd },
      { label: 'HEARTBEAT.MD', content: result.heartbeatMd },
      { label: 'BOOTSTRAP.MD', content: result.bootstrapMd },
      { label: 'AGENTS.MD',    content: result.agentsMd }
    ];

    for (const { label, content } of sections) {
      console.log(`\n========== ${label} ==========`);
      console.log(content || '(empty)');
    }

    // Print sub-agent files
    const agents = result.agents || [];
    for (const agent of agents) {
      console.log(`\n========== SUB-AGENT: ${agent.displayName} (${agent.name}) ==========`);
      console.log('--- SOUL.MD ---');
      console.log(agent.soulMd || '(empty)');
      console.log('--- AGENTS.MD ---');
      console.log(agent.agentsMd || '(empty)');
      console.log('--- HEARTBEAT.MD ---');
      console.log(agent.heartbeatMd || '(empty)');
    }

    console.error(`[done] Generated ${sections.length} main files + ${agents.length} sub-agent(s)`);
  })
  .catch((err) => {
    console.error('\n[FATAL ERROR]');
    console.error(err.stack || err);
    process.exit(1);
  });
