#!/usr/bin/env node
// CLI wrapper for profile generation. Used by test-provision.sh.
// Usage: node generate-profile.js <quiz.json> <username> <botname> <output-dir>

const path = require('path');
const fs = require('fs').promises;

async function main() {
  const [,, quizFile, username, botName, outputDir] = process.argv;

  if (!quizFile || !username || !botName || !outputDir) {
    console.error('Usage: node generate-profile.js <quiz.json> <username> <botname> <output-dir>');
    process.exit(1);
  }

  // Load profile generator from api/lib
  const { generateProfile } = require(path.resolve(__dirname, '..', 'api', 'lib', 'profile-generator.js'));

  const quizResults = JSON.parse(await fs.readFile(quizFile, 'utf8'));

  console.log(`Generating profile for ${username} (bot: ${botName})...`);
  const { soulMd, userMd, identityMd, heartbeatMd, bootstrapMd, agents, multiAgentMd } = await generateProfile(quizResults, username, botName);

  await fs.mkdir(outputDir, { recursive: true });

  await fs.writeFile(path.join(outputDir, 'SOUL.md'), soulMd);
  await fs.writeFile(path.join(outputDir, 'USER.md'), userMd);
  await fs.writeFile(path.join(outputDir, 'IDENTITY.md'), identityMd);
  await fs.writeFile(path.join(outputDir, 'HEARTBEAT.md'), heartbeatMd || '# Heartbeat\n\nNo heartbeat configuration generated.\n');
  await fs.writeFile(path.join(outputDir, 'BOOTSTRAP.md'), bootstrapMd || '# Bootstrap\n\nNo bootstrap configuration generated.\n');

  // Write sub-agent files
  if (agents && agents.length > 0) {
    const agentsDir = path.join(outputDir, 'agents');
    for (const agent of agents) {
      const agentDir = path.join(agentsDir, agent.name);
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, 'SOUL.md'), agent.soulMd);
    }
    await fs.writeFile(path.join(outputDir, 'MULTI-AGENT.md'), multiAgentMd);
    console.log(`Sub-agents generated: ${agents.map(a => a.displayName).join(', ')}`);
  }

  console.log(`Files written to ${outputDir}:`);
  const files = await fs.readdir(outputDir);
  for (const f of files) {
    const stat = await fs.stat(path.join(outputDir, f));
    if (stat.isDirectory()) {
      const subFiles = await fs.readdir(path.join(outputDir, f));
      for (const sf of subFiles) {
        const subStat = await fs.stat(path.join(outputDir, f, sf));
        if (subStat.isDirectory()) {
          const subSubFiles = await fs.readdir(path.join(outputDir, f, sf));
          for (const ssf of subSubFiles) {
            const ssStat = await fs.stat(path.join(outputDir, f, sf, ssf));
            console.log(`  ${f}/${sf}/${ssf} (${ssStat.size} bytes)`);
          }
        } else {
          console.log(`  ${f}/${sf} (${subStat.size} bytes)`);
        }
      }
    } else {
      console.log(`  ${f} (${stat.size} bytes)`);
    }
  }
}

main().catch(err => {
  console.error(`Profile generation failed: ${err.message}`);
  process.exit(1);
});
