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
      const data = await api('GET', '/portal/api/auth/check');
      return data.authenticated;
    } catch {
      return false;
    }
  }

  async function loginWithToken(token) {
    return api('POST', '/portal/api/auth/login', { token });
  }

  async function loginWithPassword(password) {
    return api('POST', '/portal/api/auth/login', { password });
  }

  async function logout() {
    await api('POST', '/portal/api/auth/logout');
    profile = null;
    showView('login');
  }

  // --- Profile ---
  async function loadProfile() {
    const data = await api('GET', '/portal/api/portal/profile');
    profile = data;
    renderHome();
  }

  function renderHome() {
    if (!profile) return;

    document.getElementById('header-url').textContent = profile.username + '.clawdaddy.sh';
    document.getElementById('welcome-title').textContent = 'Welcome, ' + profile.botName + '!';
    document.getElementById('personality-card').textContent = profile.personality || 'No personality configured yet.';

    // "Set a password" banner
    var banner = document.getElementById('set-password-banner');
    if (!profile.hasPassword) {
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }

    // Tier badge
    const tierContainer = document.getElementById('tier-badge-container');
    const tierClass = 'tier-' + (profile.tier || 'starter');
    tierContainer.innerHTML = '<span class="tier-badge ' + tierClass + '">' + (profile.tier || 'starter').toUpperCase() + '</span>';

    // Dashboard link
    const dashLink = document.getElementById('link-dashboard');
    dashLink.href = '/#token=' + (profile.gatewayToken || '');

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

    const data = await api('POST', '/portal/api/portal/settings/password', {
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

    const data = await api('POST', '/portal/api/portal/settings/api-key', { apiKey: key });

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

  // --- Init ---
  async function init() {
    // Login form
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('login-input');
      const err = document.getElementById('login-error');
      err.hidden = true;

      const result = await loginWithPassword(input.value);
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

    // "Set a password" inline form on home view
    document.getElementById('set-password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      var msg = document.getElementById('set-password-msg');
      var pw = document.getElementById('set-password-input').value;
      var confirm = document.getElementById('set-password-confirm').value;
      msg.hidden = true;

      if (pw !== confirm) {
        msg.textContent = 'Passwords do not match';
        msg.className = 'feedback-msg feedback-error';
        msg.hidden = false;
        return;
      }

      var data = await api('POST', '/portal/api/portal/settings/password', { newPassword: pw });
      if (data.ok) {
        toast('Password set successfully');
        document.getElementById('set-password-banner').hidden = true;
        e.target.reset();
        profile.hasPassword = true;
      } else {
        msg.textContent = data.error || 'Failed to set password';
        msg.className = 'feedback-msg feedback-error';
        msg.hidden = false;
      }
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

    // Auto-login from ?token= URL param
    var params = new URLSearchParams(window.location.search);
    var urlToken = params.get('token');
    if (urlToken) {
      // Strip token from URL immediately
      window.history.replaceState({}, '', '/portal/');
      var result = await loginWithToken(urlToken);
      if (result.ok) {
        await loadProfile();
        showView('home');
        return;
      }
      // Token invalid — fall through to normal auth check
    }

    // Check auth on load
    const authed = await checkAuth();
    if (authed) {
      await loadProfile();
      showView('home');
    } else {
      showView('login');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
