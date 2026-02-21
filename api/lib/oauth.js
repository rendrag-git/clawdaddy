const crypto = require('node:crypto');
const https = require('node:https');
const { spawn } = require('node:child_process');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const SCOPE = 'user:inference';

// --- PKCE helpers ---

function generateVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return crypto.randomBytes(32).toString('base64url');
}

// --- Token exchange ---

function exchangeCodeForToken(authCode, codeVerifier, state) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'authorization_code',
      code: authCode,
      code_verifier: codeVerifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state,
    });

    const url = new URL(TOKEN_URL);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'anthropic-beta': 'oauth-2025-04-20',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.access_token) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error_description || parsed.error || `Token exchange failed (${res.statusCode})`));
          }
        } catch {
          reject(new Error(`Invalid token response (${res.statusCode})`));
        }
      });
    });

    req.on('error', reject);
    const timeout = setTimeout(() => { req.destroy(); reject(new Error('Token exchange timed out')); }, 30_000);
    req.on('close', () => clearTimeout(timeout));
    req.write(body);
    req.end();
  });
}

// --- SSH token write (extracted from ssh-auth.js) ---

function sshExec(serverIp, sshKeyPath, command, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ssh', [
      '-i', sshKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      `ubuntu@${serverIp}`,
      command,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`SSH timed out (${timeoutMs}ms): ${command.substring(0, 80)}`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function writeTokenToInstance(serverIp, sshKeyPath, token) {
  return new Promise((resolve, reject) => {
    console.log('[oauth] Writing token via openclaw onboard --non-interactive...');
    const cmd = `sudo docker exec openclaw openclaw onboard --non-interactive --accept-risk --auth-choice token --token '${token}' --token-provider anthropic --skip-channels --skip-daemon --skip-skills --skip-ui --skip-health`;

    const proc = spawn('ssh', [
      '-i', sshKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      `ubuntu@${serverIp}`,
      cmd,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      console.log('[oauth] openclaw onboard timed out (30s) — resolving anyway');
      resolve();
    }, 30_000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      console.log(`[oauth] openclaw onboard exited ${code}: ${stdout.slice(0, 200)}`);
      if (code === 0) {
        resolve();
      } else {
        console.log('[oauth] openclaw onboard failed, falling back to direct file write...');
        writeAuthProfileDirect(serverIp, sshKeyPath, token)
          .then(resolve)
          .catch(reject);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function writeAuthProfileDirect(serverIp, sshKeyPath, token) {
  const authProfiles = JSON.stringify({
    version: 1,
    profiles: { 'anthropic:manual': { type: 'token', provider: 'anthropic', token } },
    order: { anthropic: ['anthropic:manual'] },
  }, null, 2) + '\n';

  const b64 = Buffer.from(authProfiles).toString('base64');

  return sshExec(serverIp, sshKeyPath, [
    `echo '${b64}' | base64 -d > /tmp/.auth-profiles-update.json`,
    `sudo docker cp /tmp/.auth-profiles-update.json openclaw:/tmp/.auth-profiles-update.json`,
    `sudo docker exec openclaw sh -c 'mkdir -p /home/clawd/.openclaw/agents/main/agent && cp /tmp/.auth-profiles-update.json /home/clawd/.openclaw/agents/main/agent/auth-profiles.json'`,
    `sudo docker exec openclaw sh -c 'for d in /home/clawd/.openclaw/agents/*/agent; do [ "$d" != "/home/clawd/.openclaw/agents/main/agent" ] && [ -d "$d" ] && cp /tmp/.auth-profiles-update.json "$d/auth-profiles.json" 2>/dev/null; done; true'`,
    `sudo docker exec openclaw chown -R clawd:clawd /home/clawd/.openclaw/agents`,
    `sudo docker exec openclaw rm -f /tmp/.auth-profiles-update.json`,
    `rm -f /tmp/.auth-profiles-update.json`,
  ].join(' && '), 30_000).then((result) => {
    if (result.code !== 0) throw new Error(`Direct write failed: ${result.stderr.slice(0, 200)}`);
    console.log('[oauth] auth-profiles.json written directly');
  });
}

// --- Public API ---

function startAuth(customer, { storeOAuthState }) {
  const codeVerifier = generateVerifier();
  const codeChallenge = generateChallenge(codeVerifier);
  const state = generateState();

  storeOAuthState(customer.id, { oauthVerifier: codeVerifier, oauthState: state });

  const url = `${AUTHORIZE_URL}?code=true`
    + `&client_id=${CLIENT_ID}`
    + `&response_type=code`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&scope=${encodeURIComponent(SCOPE)}`
    + `&code_challenge=${codeChallenge}`
    + `&code_challenge_method=S256`
    + `&state=${state}`;

  return { url };
}

async function completeAuth(customer, codeState, { clearOAuthState, updateAuth }) {
  const hashIndex = codeState.indexOf('#');
  if (hashIndex === -1) throw new Error('Invalid code format. Expected CODE#STATE.');

  const authCode = codeState.substring(0, hashIndex);
  const returnedState = codeState.substring(hashIndex + 1);

  if (!customer.oauth_state) throw new Error('No pending auth session found.');
  if (returnedState !== customer.oauth_state) throw new Error('State mismatch — possible CSRF. Please try again.');

  const tokenResponse = await exchangeCodeForToken(authCode, customer.oauth_verifier, returnedState);
  const accessToken = tokenResponse.access_token;

  // Clear ephemeral PKCE state immediately
  clearOAuthState(customer.id);

  // Write token to customer instance
  await writeTokenToInstance(customer.server_ip, customer.ssh_key_path, accessToken);

  // Update auth status
  updateAuth(customer.id, { authStatus: 'active', authProvider: 'anthropic' });

  return { success: true };
}

module.exports = {
  startAuth,
  completeAuth,
  // Exported for testing
  generateVerifier,
  generateChallenge,
  generateState,
  exchangeCodeForToken,
  writeTokenToInstance,
  writeAuthProfileDirect,
};
