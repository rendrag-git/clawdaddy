const crypto = require('node:crypto');
const https = require('node:https');
const { spawn } = require('node:child_process');

// --- Provider configuration ---

const PROVIDER_CONFIG = {
  anthropic: {
    name: 'Anthropic',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    scope: 'user:inference',
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    supportsOAuth: true,
    supportsApiKey: true,
    apiKeyPrefix: 'sk-ant-',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    logo: '/assets/providers/anthropic.svg',
  },
  openai: {
    name: 'OpenAI',
    supportsOAuth: false,
    supportsApiKey: true,
    apiKeyPrefix: 'sk-',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    logo: '/assets/providers/openai.svg',
  },
  openrouter: {
    name: 'OpenRouter',
    supportsOAuth: false,
    supportsApiKey: true,
    apiKeyPrefix: 'sk-or-',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    logo: '/assets/providers/openrouter.svg',
  },
  google: {
    name: 'Google Gemini',
    supportsOAuth: false,
    supportsApiKey: true,
    apiKeyPrefix: 'AI',
    apiKeyEnvVar: 'GOOGLE_API_KEY',
    logo: '/assets/providers/google.svg',
  },
  xai: {
    name: 'xAI',
    supportsOAuth: false,
    supportsApiKey: true,
    apiKeyPrefix: 'xai-',
    apiKeyEnvVar: 'XAI_API_KEY',
    logo: '/assets/providers/xai.svg',
  },
  groq: {
    name: 'Groq',
    supportsOAuth: false,
    supportsApiKey: true,
    apiKeyPrefix: 'gsk_',
    apiKeyEnvVar: 'GROQ_API_KEY',
    logo: '/assets/providers/groq.svg',
  },
};

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

function exchangeCodeForToken(authCode, codeVerifier, state, provider) {
  const config = PROVIDER_CONFIG[provider];
  if (!config || !config.supportsOAuth) {
    return Promise.reject(new Error(`Provider ${provider} does not support OAuth`));
  }

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'authorization_code',
      code: authCode,
      code_verifier: codeVerifier,
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      state,
    });

    const url = new URL(config.tokenUrl);
    const extraHeaders = config.headers || {};
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders,
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

// --- SSH helpers ---

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

// --- Instance write functions ---

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
      console.log('[oauth] openclaw onboard timed out (30s) -- resolving anyway');
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

function writeApiKeyToInstance(serverIp, sshKeyPath, provider, apiKey) {
  return new Promise((resolve, reject) => {
    console.log(`[oauth] Writing ${provider} API key via openclaw onboard --non-interactive...`);

    // For anthropic, use --auth-choice token --token; for others, use provider-specific flag
    let cmd;
    if (provider === 'anthropic') {
      cmd = `sudo docker exec openclaw openclaw onboard --non-interactive --accept-risk --auth-choice token --token '${apiKey}' --token-provider anthropic --skip-channels --skip-daemon --skip-skills --skip-ui --skip-health`;
    } else {
      cmd = `sudo docker exec openclaw openclaw onboard --non-interactive --accept-risk --auth-choice ${provider}-api-key --${provider}-api-key '${apiKey}' --token-provider ${provider} --skip-channels --skip-daemon --skip-skills --skip-ui --skip-health`;
    }

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
      console.log(`[oauth] openclaw onboard (${provider}) timed out (30s) -- resolving anyway`);
      resolve();
    }, 30_000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      console.log(`[oauth] openclaw onboard (${provider}) exited ${code}: ${stdout.slice(0, 200)}`);
      if (code === 0) {
        resolve();
      } else {
        // For non-anthropic providers, fall back to env var write
        console.log(`[oauth] openclaw onboard (${provider}) failed (code ${code}), falling back to env var write...`);
        const config = PROVIDER_CONFIG[provider];
        if (!config) {
          reject(new Error(`Unknown provider: ${provider}`));
          return;
        }
        writeEnvVarToInstance(serverIp, sshKeyPath, config.apiKeyEnvVar, apiKey)
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

function writeEnvVarToInstance(serverIp, sshKeyPath, envVar, value) {
  // Fallback: write env var to .env file inside the container
  const escapedValue = value.replace(/'/g, "'\\''");
  return sshExec(serverIp, sshKeyPath, [
    `sudo docker exec openclaw sh -c 'echo "${envVar}=${escapedValue}" >> /home/clawd/.env'`,
    `sudo docker exec openclaw chown clawd:clawd /home/clawd/.env`,
  ].join(' && '), 15_000).then((result) => {
    if (result.code !== 0) throw new Error(`Env var write failed: ${result.stderr.slice(0, 200)}`);
    console.log(`[oauth] ${envVar} written to instance .env`);
  });
}

// --- Public API ---

// Backward-compatible: startAuth(customer, callbacks) or startAuth(customer, provider, callbacks)
function startAuth(customer, providerOrCallbacks, maybeCallbacks) {
  let provider, callbacks;
  if (typeof providerOrCallbacks === 'string') {
    provider = providerOrCallbacks;
    callbacks = maybeCallbacks;
  } else {
    // Legacy 2-arg call: startAuth(customer, { storeOAuthState })
    provider = 'anthropic';
    callbacks = providerOrCallbacks;
  }

  const { storeOAuthState } = callbacks;
  const config = PROVIDER_CONFIG[provider];
  if (!config || !config.supportsOAuth) {
    throw new Error(`Provider ${provider} does not support OAuth`);
  }

  const codeVerifier = generateVerifier();
  const codeChallenge = generateChallenge(codeVerifier);
  const state = generateState();

  storeOAuthState(customer.id, { oauthVerifier: codeVerifier, oauthState: state });

  const url = `${config.authorizeUrl}?code=true`
    + `&client_id=${config.clientId}`
    + `&response_type=code`
    + `&redirect_uri=${encodeURIComponent(config.redirectUri)}`
    + `&scope=${encodeURIComponent(config.scope)}`
    + `&code_challenge=${codeChallenge}`
    + `&code_challenge_method=S256`
    + `&state=${state}`;

  return { url };
}

// Backward-compatible: completeAuth(customer, codeState, callbacks) or completeAuth(customer, codeState, provider, callbacks)
async function completeAuth(customer, codeState, providerOrCallbacks, maybeCallbacks) {
  let provider, callbacks;
  if (typeof providerOrCallbacks === 'string') {
    provider = providerOrCallbacks;
    callbacks = maybeCallbacks;
  } else {
    // Legacy 3-arg call: completeAuth(customer, codeState, { clearOAuthState, updateAuth })
    provider = 'anthropic';
    callbacks = providerOrCallbacks;
  }

  const { clearOAuthState, updateAuth } = callbacks;
  const config = PROVIDER_CONFIG[provider];
  if (!config || !config.supportsOAuth) {
    throw new Error(`Provider ${provider} does not support OAuth`);
  }

  const hashIndex = codeState.indexOf('#');
  if (hashIndex === -1) throw new Error('Invalid code format. Expected CODE#STATE.');

  const authCode = codeState.substring(0, hashIndex);
  const returnedState = codeState.substring(hashIndex + 1);

  if (!customer.oauth_state) throw new Error('No pending auth session found.');
  if (returnedState !== customer.oauth_state) throw new Error('State mismatch -- possible CSRF. Please try again.');

  const tokenResponse = await exchangeCodeForToken(authCode, customer.oauth_verifier, returnedState, provider);
  const accessToken = tokenResponse.access_token;

  // Clear ephemeral PKCE state immediately
  clearOAuthState(customer.id);

  // Write token to customer instance
  await writeTokenToInstance(customer.server_ip, customer.ssh_key_path, accessToken);

  // Update auth status
  updateAuth(customer.id, { authStatus: 'active', authProvider: provider });

  return { success: true };
}

async function authWithApiKey(customer, provider, apiKey, { updateAuth }) {
  const config = PROVIDER_CONFIG[provider];
  if (!config || !config.supportsApiKey) {
    throw new Error(`Provider ${provider} does not support API key auth`);
  }

  // Basic prefix validation
  if (config.apiKeyPrefix && !apiKey.startsWith(config.apiKeyPrefix)) {
    throw new Error(`Invalid API key format for ${config.name}. Expected prefix: ${config.apiKeyPrefix}`);
  }

  // Write key to instance
  await writeApiKeyToInstance(customer.server_ip, customer.ssh_key_path, provider, apiKey);

  // Update auth status
  updateAuth(customer.id, { authStatus: 'active', authProvider: provider });

  return { success: true };
}

function getProviderList() {
  return Object.entries(PROVIDER_CONFIG).map(([id, config]) => ({
    id,
    name: config.name,
    supportsOAuth: config.supportsOAuth,
    supportsApiKey: config.supportsApiKey,
    logo: config.logo,
  }));
}

module.exports = {
  startAuth,
  completeAuth,
  authWithApiKey,
  getProviderList,
  PROVIDER_CONFIG,
  // Exported for testing
  generateVerifier,
  generateChallenge,
  generateState,
  exchangeCodeForToken,
  writeTokenToInstance,
  writeAuthProfileDirect,
  writeApiKeyToInstance,
  writeEnvVarToInstance,
};
