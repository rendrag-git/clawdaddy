const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const URL_WAIT_TIMEOUT_MS = 30 * 1000;  // 30s for URL to appear (claude setup-token takes ~10-12s)
const CODE_WAIT_TIMEOUT_MS = 15 * 1000; // 15s for token after code submitted
const STDIN_DELAY_MS = 500;              // delay before writing to stdin

const sessions = new Map();

// --- stdout line buffer ---
// SSH over PTY can split output mid-line. Buffer until newline before matching.

function createLineBuffer(onLine) {
  let partial = '';
  return (chunk) => {
    partial += chunk.toString();
    const lines = partial.split('\n');
    partial = lines.pop(); // hold trailing partial
    for (const line of lines) {
      onLine(line);
    }
  };
}

// --- helpers ---

// Strip ANSI escape codes and carriage returns from PTY output
function stripAnsi(str) {
  return str.replace(/\x1b\[[?0-9;]*[a-zA-Z]/g, '').replace(/\x1b[()][0-9A-B]/g, '').replace(/\r/g, '');
}

// --- Anthropic flow ---

function startAnthropic(serverIp, sshKeyPath) {
  return new Promise((resolve, reject) => {
    const authSessionId = crypto.randomUUID();
    const proc = spawn('ssh', [
      '-tt', '-i', sshKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      `ubuntu@${serverIp}`,
      'sudo docker exec -it openclaw claude setup-token'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let resolved = false;
    let rawBuffer = '';
    const stdoutLines = [];

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup(authSessionId);
        reject(new Error('Timed out waiting for Anthropic OAuth URL'));
      }
    }, URL_WAIT_TIMEOUT_MS);

    // Accumulate raw output, strip ANSI, scan full buffer for URL
    // PTY word-wraps long URLs across multiple lines — can't match per-line
    proc.stdout.on('data', (chunk) => {
      rawBuffer += chunk.toString();
      const clean = stripAnsi(rawBuffer).replace(/\n/g, '');
      const urlMatch = clean.match(/(https:\/\/claude\.ai\/oauth\/authorize[^\s]*state=[^\s]*)/);
      if (urlMatch && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        const session = {
          proc,
          provider: 'anthropic',
          serverIp,
          sshKeyPath,
          stdoutLines,
          createdAt: Date.now(),
          timeoutHandle: setTimeout(() => cleanup(authSessionId), AUTH_TIMEOUT_MS),
        };
        sessions.set(authSessionId, session);
        resolve({ authSessionId, oauthUrl: urlMatch[1] });
      }
    });
    proc.stderr.on('data', () => {}); // ignore stderr

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`SSH connection failed: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`SSH process exited with code ${code} before OAuth URL appeared`));
      }
    });
  });
}

function completeAnthropic(authSessionId, codeWithState) {
  return new Promise((resolve, reject) => {
    const session = sessions.get(authSessionId);
    if (!session) return reject(new Error('Auth session not found or expired'));
    if (session.provider !== 'anthropic') return reject(new Error('Wrong provider for this session'));

    let resolved = false;
    let rawBuffer = '';

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup(authSessionId);
        reject(new Error('Timed out waiting for Anthropic token'));
      }
    }, 30_000); // 30s for token exchange (was 15s)

    // Replace stdout handler — use raw buffer + ANSI stripping like startAnthropic
    session.proc.stdout.removeAllListeners('data');
    session.proc.stdout.on('data', (chunk) => {
      rawBuffer += chunk.toString();
      const clean = stripAnsi(rawBuffer).replace(/\n/g, '');

      const tokenMatch = clean.match(/(sk-ant-oat01-[^\s]+)/);
      if (tokenMatch && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        const token = tokenMatch[1];

        // Kill interactive process
        session.proc.kill();
        clearTimeout(session.timeoutHandle);

        // Write auth-profiles.json via non-interactive SSH
        writeAuthProfile(session.serverIp, session.sshKeyPath, 'anthropic', token)
          .then(() => {
            sessions.delete(authSessionId);
            resolve({ ok: true, provider: 'anthropic', profileName: 'anthropic:manual' });
          })
          .catch((err) => {
            sessions.delete(authSessionId);
            reject(new Error(`Token obtained but failed to write auth profile: ${err.message}`));
          });
      }

      // Check for error
      if (clean.includes('OAuth error') && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        cleanup(authSessionId);
        reject(new Error(`Anthropic auth error: ${clean.slice(-200)}`));
      }
    });

    // Write code to stdin after delay
    setTimeout(() => {
      if (!resolved) {
        session.proc.stdin.write(codeWithState + '\n');
      }
    }, STDIN_DELAY_MS);
  });
}

// --- OpenAI flow ---

function startOpenai(serverIp, sshKeyPath) {
  return new Promise((resolve, reject) => {
    const authSessionId = crypto.randomUUID();
    const proc = spawn('ssh', [
      '-tt', '-i', sshKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      `ubuntu@${serverIp}`,
      'sudo docker exec -it openclaw openclaw onboard --auth-choice openai-codex'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let resolved = false;
    let wizardStep = 0; // 0=security, 1=quickstart, 2=config, 3=waiting-for-url
    const stdoutLines = [];
    const expectedPrompts = [
      { pattern: /continue|security|disclaimer/i, action: () => proc.stdin.write('\n'), name: 'security disclaimer' },
      { pattern: /quickstart|onboarding mode/i, action: () => proc.stdin.write('\n'), name: 'onboarding mode' },
      { pattern: /update values|use existing|config/i, action: () => proc.stdin.write('\n'), name: 'config handling' },
    ];

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup(authSessionId);
        reject(new Error('Timed out waiting for OpenAI OAuth URL'));
      }
    }, URL_WAIT_TIMEOUT_MS);

    const onLine = (line) => {
      stdoutLines.push(line);

      // Check for OAuth URL first (highest priority)
      const urlMatch = line.match(/(https:\/\/auth\.openai\.com\/oauth\/authorize[^\s]*)/);
      if (urlMatch && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        wizardStep = expectedPrompts.length; // done with wizard
        const session = {
          proc,
          provider: 'openai',
          serverIp,
          sshKeyPath,
          stdoutLines,
          createdAt: Date.now(),
          timeoutHandle: setTimeout(() => cleanup(authSessionId), AUTH_TIMEOUT_MS),
        };
        sessions.set(authSessionId, session);
        resolve({ authSessionId, oauthUrl: urlMatch[1] });
        return;
      }

      // Navigate wizard prompts in order
      if (wizardStep < expectedPrompts.length) {
        const expected = expectedPrompts[wizardStep];
        if (expected.pattern.test(line)) {
          setTimeout(() => {
            expected.action();
            wizardStep++;
          }, STDIN_DELAY_MS);
        }
        // Don't abort on unexpected lines during wizard — lots of decorative output
      }
    };

    const lineHandler = createLineBuffer(onLine);
    proc.stdout.on('data', lineHandler);
    proc.stderr.on('data', () => {});

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`SSH connection failed: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`SSH process exited with code ${code} before OAuth URL appeared`));
      }
    });
  });
}

function completeOpenai(authSessionId, redirectUrl) {
  return new Promise((resolve, reject) => {
    const session = sessions.get(authSessionId);
    if (!session) return reject(new Error('Auth session not found or expired'));
    if (session.provider !== 'openai') return reject(new Error('Wrong provider for this session'));

    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup(authSessionId);
        reject(new Error('Timed out waiting for OpenAI token exchange'));
      }
    }, CODE_WAIT_TIMEOUT_MS);

    const onLine = (line) => {
      session.stdoutLines.push(line);
      if (line.includes('Model configured') && !resolved) {
        resolved = true;
        clearTimeout(timeout);

        // Send Escape to exit wizard, then kill
        session.proc.stdin.write('\x1b');
        setTimeout(() => {
          session.proc.kill();
          clearTimeout(session.timeoutHandle);
          sessions.delete(authSessionId);
          resolve({ ok: true, provider: 'openai', profileName: 'openai-codex' });
        }, 500);
      }
    };

    session.proc.stdout.removeAllListeners('data');
    session.proc.stdout.on('data', createLineBuffer(onLine));

    // Write redirect URL to stdin after delay
    setTimeout(() => {
      if (!resolved) {
        session.proc.stdin.write(redirectUrl + '\n');
      }
    }, STDIN_DELAY_MS);
  });
}

// --- auth-profiles.json write ---
// Correct format matching entrypoint convention:
// { "version": 1, "profiles": { "anthropic:manual": { "type": "token", "provider": "anthropic", "token": "..." } }, "order": { "anthropic": ["anthropic:manual"] } }
// Pipes JSON via stdin to avoid shell injection.

function writeAuthProfile(serverIp, sshKeyPath, provider, token) {
  return new Promise((resolve, reject) => {
    let profileName, profileEntry, orderKey;

    if (provider === 'anthropic') {
      profileName = 'anthropic:manual';
      orderKey = 'anthropic';
      profileEntry = { type: 'token', provider: 'anthropic', token };
    } else if (provider === 'openai') {
      profileName = 'openai-codex:oauth';
      orderKey = 'openai-codex';
      profileEntry = { type: 'token', provider: 'openai-codex', token };
    } else {
      return reject(new Error(`Unknown provider: ${provider}`));
    }

    // Build the update payload — the remote script reads this from stdin
    const updatePayload = JSON.stringify({ profileName, profileEntry, orderKey });

    // Remote node script: reads JSON from stdin, merges into each auth-profiles.json
    // Runs inside Docker container where openclaw stores auth profiles
    const containerScript = `
      node -e '
        const fs = require("fs");
        const { profileName, profileEntry, orderKey } = JSON.parse(require("fs").readFileSync("/dev/stdin", "utf8"));
        const glob = require("child_process").execSync("ls /home/clawd/.openclaw/agents/*/agent/auth-profiles.json 2>/dev/null || true", { encoding: "utf8" }).trim().split("\\n").filter(Boolean);
        let wrote = 0;
        for (const f of glob) {
          let existing = { version: 1, profiles: {}, order: {} };
          try { existing = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
          existing.version = existing.version || 1;
          existing.profiles = existing.profiles || {};
          existing.order = existing.order || {};
          existing.profiles[profileName] = profileEntry;
          if (!existing.order[orderKey]) existing.order[orderKey] = [];
          if (!existing.order[orderKey].includes(profileName)) existing.order[orderKey].push(profileName);
          fs.writeFileSync(f, JSON.stringify(existing, null, 2));
          wrote++;
        }
        console.log("AUTH_PROFILE_WRITTEN:" + wrote);
      '
    `.trim().replace(/'/g, "'\\''");

    const remoteScript = `sudo docker exec -i openclaw bash -c '${containerScript}'`;

    const proc = spawn('ssh', [
      '-i', sshKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      `ubuntu@${serverIp}`,
      remoteScript
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    // Pipe the update payload via stdin (no shell interpolation)
    proc.stdin.write(updatePayload);
    proc.stdin.end();

    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('AUTH_PROFILE_WRITTEN')) {
        resolve();
      } else {
        reject(new Error(`Auth profile write failed (exit ${code}): ${stdout.slice(-200)}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

// --- public API ---

async function startAuth(provider, serverIp, sshKeyPath) {
  if (provider === 'anthropic') return startAnthropic(serverIp, sshKeyPath);
  if (provider === 'openai') return startOpenai(serverIp, sshKeyPath);
  throw new Error(`Unknown provider: ${provider}`);
}

async function completeAuth(authSessionId, code) {
  const session = sessions.get(authSessionId);
  if (!session) throw new Error('Auth session not found or expired');
  if (session.provider === 'anthropic') return completeAnthropic(authSessionId, code);
  if (session.provider === 'openai') return completeOpenai(authSessionId, code);
  throw new Error(`Unknown provider: ${session.provider}`);
}

function cleanup(authSessionId) {
  const session = sessions.get(authSessionId);
  if (session) {
    try { session.proc.kill(); } catch {}
    clearTimeout(session.timeoutHandle);
    sessions.delete(authSessionId);
  }
}

function cleanupExpired() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > AUTH_TIMEOUT_MS) {
      console.log(`Cleaning up expired auth session: ${id}`);
      cleanup(id);
    }
  }
}

// Run cleanup every 30 seconds
const cleanupInterval = setInterval(cleanupExpired, 30_000);
cleanupInterval.unref(); // don't prevent process exit

module.exports = { startAuth, completeAuth, cleanup, cleanupExpired };
