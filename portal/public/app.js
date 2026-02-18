(function() {
  let profile = null;
  let configuredProviders = [];

  const CURATED_MODELS = [
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic' },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'anthropic' },
    { value: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'openai' },
    { value: 'o1', label: 'o1', provider: 'openai' },
    { value: 'o3-mini', label: 'o3-mini', provider: 'openai' },
  ];

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

    // Raw dashboard link in config view
    var rawDashLink = document.getElementById('link-raw-dashboard');
    if (rawDashLink) {
      rawDashLink.href = '/#token=' + (profile.gatewayToken || '');
    }

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

  // --- Config View ---
  async function loadKeys() {
    var container = document.getElementById('keys-container');
    container.innerHTML = '';

    var data = await api('GET', '/portal/api/config/keys');
    if (!data.ok) {
      container.innerHTML = '<p class="text-muted">Failed to load API keys.</p>';
      return;
    }

    configuredProviders = data.providers.filter(function(p) { return p.configured; }).map(function(p) { return p.provider; });

    for (var i = 0; i < data.providers.length; i++) {
      var prov = data.providers[i];
      var card = document.createElement('div');
      card.className = 'key-card';
      card.dataset.provider = prov.provider;

      var info = document.createElement('div');
      info.className = 'key-card-info';

      var name = document.createElement('span');
      name.className = 'key-card-provider';
      name.textContent = prov.provider;
      info.appendChild(name);

      if (prov.configured) {
        var masked = document.createElement('span');
        masked.className = 'key-card-masked';
        masked.textContent = prov.masked;
        info.appendChild(masked);

        var dot = document.createElement('span');
        dot.className = 'status-dot status-online';
        dot.style.marginLeft = '0.5rem';
        info.appendChild(dot);
      } else {
        var status = document.createElement('span');
        status.className = 'key-card-status';
        status.textContent = 'Not configured';
        info.appendChild(status);
      }

      card.appendChild(info);

      var actions = document.createElement('div');
      actions.className = 'key-card-actions';

      if (prov.configured) {
        var removeBtn = document.createElement('button');
        removeBtn.className = 'btn-text';
        removeBtn.textContent = 'Remove';
        removeBtn.dataset.provider = prov.provider;
        removeBtn.addEventListener('click', function(e) {
          removeKey(e.currentTarget.dataset.provider);
        });
        actions.appendChild(removeBtn);
      }

      var addBtn = document.createElement('button');
      addBtn.className = prov.configured ? 'btn-secondary' : 'btn-primary';
      addBtn.textContent = prov.configured ? 'Update Key' : 'Add API Key';
      addBtn.dataset.provider = prov.provider;
      addBtn.addEventListener('click', function(e) {
        var btn = e.currentTarget;
        var parentCard = btn.closest('.key-card');
        toggleKeyInput(parentCard, btn.dataset.provider);
      });
      actions.appendChild(addBtn);

      card.appendChild(actions);
      container.appendChild(card);
    }
  }

  function toggleKeyInput(card, provider) {
    var existing = card.querySelector('.key-input-row');
    if (existing) {
      existing.remove();
      var fb = card.querySelector('.key-feedback');
      if (fb) fb.remove();
      return;
    }

    var row = document.createElement('div');
    row.className = 'key-input-row';

    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = provider === 'anthropic' ? 'sk-ant-...' :
                        provider === 'openai' ? 'sk-...' :
                        provider === 'openrouter' ? 'sk-or-...' : 'AI...';
    input.autocomplete = 'off';

    var testBtn = document.createElement('button');
    testBtn.className = 'btn-secondary';
    testBtn.textContent = 'Test';
    testBtn.addEventListener('click', function() {
      testKey(card, provider, input.value);
    });

    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', function() {
      saveKey(card, provider, input.value);
    });

    row.appendChild(input);
    row.appendChild(testBtn);
    row.appendChild(saveBtn);
    card.appendChild(row);
    input.focus();
  }

  async function testKey(card, provider, key) {
    setKeyFeedback(card, 'Testing...', '');
    var data = await api('POST', '/portal/api/config/keys/test', { provider: provider, key: key });
    if (data.ok) {
      setKeyFeedback(card, data.message, 'feedback-success');
    } else {
      setKeyFeedback(card, data.error, 'feedback-error');
    }
  }

  async function saveKey(card, provider, key) {
    setKeyFeedback(card, 'Saving...', '');
    var data = await api('POST', '/portal/api/config/keys', { provider: provider, key: key });
    if (data.ok) {
      toast(provider + ' key saved');
      loadKeys();
      loadAgents();
    } else {
      setKeyFeedback(card, data.error, 'feedback-error');
    }
  }

  async function removeKey(provider) {
    var data = await api('DELETE', '/portal/api/config/keys/' + provider);
    if (data.ok) {
      toast(provider + ' key removed');
      loadKeys();
      loadAgents();
    } else {
      toast(data.error || 'Failed to remove key');
    }
  }

  function setKeyFeedback(card, message, className) {
    var fb = card.querySelector('.key-feedback');
    if (!fb) {
      fb = document.createElement('div');
      fb.className = 'key-feedback';
      card.appendChild(fb);
    }
    fb.textContent = message;
    fb.className = 'key-feedback ' + (className || '');
  }

  async function loadAgents() {
    var container = document.getElementById('agents-container');
    container.innerHTML = '';

    var data = await api('GET', '/portal/api/config/agents');
    if (!data.ok) {
      container.innerHTML = '<p class="text-muted">Failed to load agents.</p>';
      return;
    }

    for (var i = 0; i < data.agents.length; i++) {
      var agent = data.agents[i];
      var card = document.createElement('div');
      card.className = 'agent-card';

      var header = document.createElement('div');
      header.className = 'agent-card-header';

      var agentName = document.createElement('span');
      agentName.className = 'agent-card-name';
      agentName.textContent = agent.name;
      header.appendChild(agentName);

      var currentModel = document.createElement('span');
      currentModel.className = 'agent-card-model';
      currentModel.textContent = agent.model || 'not set';
      header.appendChild(currentModel);

      card.appendChild(header);

      var row = document.createElement('div');
      row.className = 'agent-model-row';

      var select = document.createElement('select');
      var defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = '\u2014 select model \u2014';
      select.appendChild(defaultOpt);

      var available = CURATED_MODELS.filter(function(m) {
        return configuredProviders.indexOf(m.provider) !== -1;
      });

      var addedProviders = {};
      for (var j = 0; j < available.length; j++) {
        var m = available[j];
        if (!addedProviders[m.provider]) {
          var group = document.createElement('optgroup');
          group.label = m.provider.charAt(0).toUpperCase() + m.provider.slice(1);
          var providerModels = available.filter(function(x) { return x.provider === m.provider; });
          for (var k = 0; k < providerModels.length; k++) {
            var opt = document.createElement('option');
            opt.value = providerModels[k].value;
            opt.textContent = providerModels[k].label;
            if (providerModels[k].value === agent.model) opt.selected = true;
            group.appendChild(opt);
          }
          select.appendChild(group);
          addedProviders[m.provider] = true;
        }
      }

      var customOpt = document.createElement('option');
      customOpt.value = '__custom__';
      customOpt.textContent = 'Custom...';
      select.appendChild(customOpt);

      var isCurated = CURATED_MODELS.some(function(cm) { return cm.value === agent.model; });
      if (agent.model && !isCurated) {
        customOpt.selected = true;
      }

      var customInput = document.createElement('input');
      customInput.type = 'text';
      customInput.className = 'custom-model-input';
      customInput.placeholder = 'model-name';
      if (agent.model && !isCurated) {
        customInput.classList.add('visible');
        customInput.value = agent.model;
      }

      select.addEventListener('change', (function(ci) {
        return function(e) {
          if (e.target.value === '__custom__') {
            ci.classList.add('visible');
            ci.focus();
          } else {
            ci.classList.remove('visible');
            ci.value = '';
          }
        };
      })(customInput));

      var applyBtn = document.createElement('button');
      applyBtn.className = 'btn-primary';
      applyBtn.textContent = 'Apply';

      (function(agentObj, sel, ci, cm, btn) {
        btn.addEventListener('click', async function() {
          var model = sel.value === '__custom__' ? ci.value : sel.value;
          if (!model) return;
          btn.textContent = 'Saving...';
          btn.disabled = true;
          var result = await api('PATCH', '/portal/api/config/agents/' + agentObj.id, { model: model });
          if (result.ok) {
            toast(agentObj.name + ' model updated');
            cm.textContent = model;
          } else {
            toast(result.error || 'Failed to update');
          }
          btn.textContent = 'Apply';
          btn.disabled = false;
        });
      })(agent, select, customInput, currentModel, applyBtn);

      row.appendChild(select);
      row.appendChild(customInput);
      row.appendChild(applyBtn);
      card.appendChild(row);
      container.appendChild(card);
    }
  }

  async function downloadConfig() {
    var data = await api('GET', '/portal/api/config/agents');
    if (!data.ok) {
      toast('Failed to download config');
      return;
    }
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'openclaw.json';
    a.click();
    URL.revokeObjectURL(url);
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

    // Config view navigation
    document.getElementById('link-config').addEventListener('click', function() {
      showView('config');
      loadKeys();
      loadAgents();
    });
    document.getElementById('btn-config-back').addEventListener('click', function() {
      showView('home');
    });
    document.getElementById('btn-download-config').addEventListener('click', downloadConfig);

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
