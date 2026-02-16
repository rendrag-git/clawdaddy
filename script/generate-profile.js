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
  const { soulMd, userMd, identityMd } = await generateProfile(quizResults, username, botName);

  await fs.mkdir(outputDir, { recursive: true });

  // Read BOOTSTRAP.md template
  const templateDir = path.resolve(__dirname, '..', 'templates');
  let bootstrapMd = '';
  try {
    bootstrapMd = await fs.readFile(path.join(templateDir, 'BOOTSTRAP.md'), 'utf8');
  } catch (e) {
    bootstrapMd = `# Bootstrap\n\nWelcome! Read SOUL.md, USER.md, and IDENTITY.md to learn who you are and who you're helping. Then introduce yourself.\n`;
  }

  await fs.writeFile(path.join(outputDir, 'SOUL.md'), soulMd);
  await fs.writeFile(path.join(outputDir, 'USER.md'), userMd);
  await fs.writeFile(path.join(outputDir, 'IDENTITY.md'), identityMd);
  await fs.writeFile(path.join(outputDir, 'BOOTSTRAP.md'), bootstrapMd);

  console.log(`Files written to ${outputDir}:`);
  const files = await fs.readdir(outputDir);
  for (const f of files) {
    const stat = await fs.stat(path.join(outputDir, f));
    console.log(`  ${f} (${stat.size} bytes)`);
  }
}

main().catch(err => {
  console.error(`Profile generation failed: ${err.message}`);
  process.exit(1);
});
