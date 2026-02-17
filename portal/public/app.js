(function() {
  let profile = null;

  // --- Routing ---
  function showView(id) {
    document.querySelectorAll('.view').forEach(v => v.hidden = true);
    document.getElementById('view-' + id).hidden = false;
  }

  // --- Toast ---
  function toast(msg, duration = 3000) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  // --- API helpers ---
  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    return res.json();
  }

  // --- Auth ---
  async function checkAuth() {
    try {
      const data = await api('GET', '/api/auth/check');
      return data.authenticated;
    } catch {
      return false;
    }
  }

  async function login(credential) {
    return api('POST', '/api/auth/login', { token: credential, password: credential });
  }

  async function logout() {
    await api('POST', '/api/auth/logout');
    profile = null;
    showView('login');
  }

  // --- Profile ---
  async function loadProfile() {
    const data = await api('GET', '/api/portal/profile');
    profile = data;
    renderHome();
  }

  function renderHome() {
    if (!profile) return;

    document.getElementById('header-url').textContent = profile.username + '.clawdaddy.sh';
    document.getElementById('welcome-title').textContent = 'Welcome, ' + profile.botName + '!';
    document.getElementById('personality-card').textContent = profile.personality || 'No personality configured yet.';

    // Tier badge
    const tierContainer = document.getElementById('tier-badge-container');
    const tierClass = 'tier-' + (profile.tier || 'starter');
    tierContainer.innerHTML = '<span class="tier-badge ' + tierClass + '">' + (profile.tier || 'starter').toUpperCase() + '</span>';

    // Dashboard link
    const dashLink = document.getElementById('link-dashboard');
    dashLink.href = '/dashboard' + (profile.gatewayToken ? '?token=' + profile.gatewayToken : '');

    // API key
    const apikeyStatus = document.getElementById('apikey-status');
    const apikeyMasked = document.getElementById('apikey-masked');
    if (profile.apiKeyConfigured) {
      apikeyStatus.innerHTML = '<span class="status-dot status-online"></span> Configured';
      apikeyMasked.textContent = profile.apiKeyMasked || '';
    } else {
      apikeyStatus.innerHTML = '<span class="status-dot status-offline"></span> Not configured';
      apikeyMasked.textContent = '';
    }

    // Health
    const healthStatus = document.getElementById('health-status');
    if (profile.instanceHealthy) {
      healthStatus.innerHTML = '<span class="status-dot status-online"></span> Online';
    } else {
      healthStatus.innerHTML = '<span class="status-dot status-offline"></span> Offline';
    }

    // Settings view: current API key
    document.getElementById('settings-apikey-current').textContent = profile.apiKeyMasked || 'Not configured';
  }

  // --- Settings ---
  async function updatePassword(form) {
    const msg = document.getElementById('password-msg');
    const current = document.getElementById('current-password').value;
    const newPw = document.getElementById('new-password').value;
    const confirm = document.getElementById('confirm-password').value;

    if (newPw !== confirm) {
      msg.textContent = 'Passwords do not match';
      msg.className = 'feedback-msg feedback-error';
      msg.hidden = false;
      return;
    }

    const data = await api('POST', '/api/portal/settings/password', {
      currentPassword: current,
      newPassword: newPw
    });

    if (data.ok) {
      msg.textContent = 'Password updated';
      msg.className = 'feedback-msg feedback-success';
      form.reset();
    } else {
      msg.textContent = data.error || 'Failed to update password';
      msg.className = 'feedback-msg feedback-error';
    }
    msg.hidden = false;
  }

  async function updateApiKey(form) {
    const msg = document.getElementById('apikey-msg');
    const key = document.getElementById('new-apikey').value;

    const data = await api('POST', '/api/portal/settings/api-key', { apiKey: key });

    if (data.ok) {
      msg.textContent = data.message || 'API key updated';
      msg.className = 'feedback-msg feedback-success';
      form.reset();
      loadProfile(); // refresh
    } else {
      msg.textContent = data.error || 'Failed to update';
      msg.className = 'feedback-msg feedback-error';
    }
    msg.hidden = false;
  }

  // --- Set-password banner ---
  function renderPasswordBanner() {
    const banner = document.getElementById('set-password-banner');
    if (!banner) return;
    if (profile && profile.hasPassword === false) {
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  async function submitSetPassword(form) {
    const msg = document.getElementById('set-password-msg');
    const pw = document.getElementById('set-password-input').value;
    const confirm = document.getElementById('set-password-confirm').value;

    if (pw.length < 6) {
      msg.textContent = 'Password must be at least 6 characters';
      msg.className = 'feedback-msg feedback-error';
      msg.hidden = false;
      return;
    }

    if (pw !== confirm) {
      msg.textContent = 'Passwords do not match';
      msg.className = 'feedback-msg feedback-error';
      msg.hidden = false;
      return;
    }

    const data = await api('POST', '/api/portal/settings/password', { newPassword: pw });

    if (data.ok) {
      msg.textContent = 'Password set!';
      msg.className = 'feedback-msg feedback-success';
      form.reset();
      profile.hasPassword = true;
      renderPasswordBanner();
      toast('Password saved');
    } else {
      msg.textContent = data.error || 'Failed to set password';
      msg.className = 'feedback-msg feedback-error';
    }
    msg.hidden = false;
  }

  // --- Auto-login from URL token ---
  async function tryTokenLogin() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) return false;

    // Strip token from URL immediately
    window.history.replaceState({}, '', window.location.pathname);

    const result = await login(token);
    return result.ok;
  }

  // --- Init ---
  async function init() {
    // Login form
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('login-input');
      const err = document.getElementById('login-error');
      err.hidden = true;

      const result = await login(input.value);
      if (result.ok) {
        await loadProfile();
        showView('home');
      } else {
        err.textContent = result.error || 'Invalid credentials';
        err.hidden = false;
      }
    });

    // Navigation
    document.getElementById('btn-settings').addEventListener('click', () => showView('settings'));
    document.getElementById('link-settings').addEventListener('click', () => showView('settings'));
    document.getElementById('btn-back').addEventListener('click', () => showView('home'));
    document.getElementById('btn-logout').addEventListener('click', logout);
    document.getElementById('link-discord').addEventListener('click', (e) => {
      e.preventDefault();
      toast('Discord setup coming soon');
    });

    // Settings forms
    document.getElementById('password-form').addEventListener('submit', (e) => {
      e.preventDefault();
      updatePassword(e.target);
    });

    document.getElementById('apikey-form').addEventListener('submit', (e) => {
      e.preventDefault();
      updateApiKey(e.target);
    });

    // Set-password banner form
    const spForm = document.getElementById('set-password-form');
    if (spForm) {
      spForm.addEventListener('submit', (e) => {
        e.preventDefault();
        submitSetPassword(e.target);
      });
    }

    // Auto-login from ?token= URL param
    const tokenLoggedIn = await tryTokenLogin();
    if (tokenLoggedIn) {
      await loadProfile();
      renderPasswordBanner();
      showView('home');
      return;
    }

    // Check existing session
    const authed = await checkAuth();
    if (authed) {
      await loadProfile();
      renderPasswordBanner();
      showView('home');
    } else {
      showView('login');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
