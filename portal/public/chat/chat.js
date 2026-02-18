(function () {
  'use strict';

  // ── State ──
  let agents = [];
  let activeAgentId = null;
  let streaming = false;

  // ── DOM refs ──
  const $ = (sel) => document.querySelector(sel);
  const sidebar = $('#sidebar');
  const overlay = $('#sidebar-overlay');
  const channelList = $('#channel-list');
  const messagesEl = $('#messages');
  const msgInput = $('#msg-input');
  const btnSend = $('#btn-send');
  const headerEmoji = $('#header-agent-emoji');
  const headerName = $('#header-agent-name');
  const threadPicker = $('#thread-picker');
  const threadListEl = $('#thread-list');

  // ── Helpers ──
  function genId() {
    return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
  }

  function formatDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // ── Storage ──
  function storageKey(agentId) { return 'clawd_agent_' + agentId; }

  function loadAgentData(agentId) {
    try {
      const raw = localStorage.getItem(storageKey(agentId));
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return { threads: [], activeThreadId: null };
  }

  function saveAgentData(agentId, data) {
    localStorage.setItem(storageKey(agentId), JSON.stringify(data));
  }

  function getActiveThread(agentId) {
    const data = loadAgentData(agentId);
    if (!data.activeThreadId && data.threads.length > 0) {
      data.activeThreadId = data.threads[0].id;
    }
    return data.threads.find((t) => t.id === data.activeThreadId) || null;
  }

  function ensureThread(agentId) {
    const data = loadAgentData(agentId);
    if (data.threads.length === 0) {
      const thread = { id: genId(), title: 'New conversation', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      data.threads.unshift(thread);
      data.activeThreadId = thread.id;
      saveAgentData(agentId, data);
    }
    return loadAgentData(agentId);
  }

  function addMessage(agentId, threadId, role, content) {
    const data = loadAgentData(agentId);
    const thread = data.threads.find((t) => t.id === threadId);
    if (!thread) return;
    thread.messages.push({ role, content, ts: Date.now() });
    thread.updatedAt = Date.now();
    if (role === 'user' && thread.messages.filter((m) => m.role === 'user').length === 1) {
      thread.title = truncate(content, 50);
    }
    // Move thread to top
    const idx = data.threads.indexOf(thread);
    if (idx > 0) {
      data.threads.splice(idx, 1);
      data.threads.unshift(thread);
    }
    saveAgentData(agentId, data);
  }

  function updateLastMessage(agentId, threadId, content) {
    const data = loadAgentData(agentId);
    const thread = data.threads.find((t) => t.id === threadId);
    if (!thread || thread.messages.length === 0) return;
    const last = thread.messages[thread.messages.length - 1];
    if (last.role === 'assistant') {
      last.content = content;
      thread.updatedAt = Date.now();
      saveAgentData(agentId, data);
    }
  }

  // Unread tracking
  function markRead(agentId) {
    localStorage.setItem('clawd_read_' + agentId, String(Date.now()));
  }

  function hasUnread(agentId) {
    const lastRead = parseInt(localStorage.getItem('clawd_read_' + agentId) || '0', 10);
    const data = loadAgentData(agentId);
    if (data.threads.length === 0) return false;
    return data.threads.some((t) => t.updatedAt > lastRead && t.messages.length > 0);
  }

  // ── API ──
  async function api(method, path, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (res.status === 401) {
      window.location.href = '/portal/';
      throw new Error('Unauthorized');
    }
    return res;
  }

  async function checkAuth() {
    const res = await api('GET', '/portal/api/auth/check');
    const data = await res.json();
    return data.authenticated;
  }

  async function fetchAgents() {
    const res = await api('GET', '/portal/api/chat/agents');
    const data = await res.json();
    return data.agents || [];
  }

  // ── Markdown renderer ──
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMarkdown(src) {
    if (!src) return '';

    var text = String(src).replace(/\r\n/g, '\n');

    // 1. Extract code blocks BEFORE escaping so content stays raw
    var codeBlocks = [];
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      var idx = codeBlocks.length;
      codeBlocks.push('<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>');
      return '@@CB' + idx + '@@';
    });

    // 2. Extract inline code before escaping
    var inlineCode = [];
    text = text.replace(/`([^`\n]+)`/g, function (_, code) {
      var idx = inlineCode.length;
      inlineCode.push('<code>' + escapeHtml(code) + '</code>');
      return '@@IC' + idx + '@@';
    });

    // 3. Extract links before escaping (preserve href)
    var links = [];
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, label, url) {
      var idx = links.length;
      links.push('<a href="' + encodeURI(url) + '" target="_blank" rel="noopener">' + escapeHtml(label) + '</a>');
      return '@@LK' + idx + '@@';
    });

    // 4. Now escape everything else
    text = escapeHtml(text);

    // 5. Restore placeholders
    text = text.replace(/@@CB(\d+)@@/g, function (_, i) { return codeBlocks[i]; });
    text = text.replace(/@@IC(\d+)@@/g, function (_, i) { return inlineCode[i]; });
    text = text.replace(/@@LK(\d+)@@/g, function (_, i) { return links[i]; });

    // Headers
    text = text.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Horizontal rules
    text = text.replace(/^---+$/gm, '<hr>');

    // Bold + italic
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');

    // Blockquotes (escaped > becomes &gt;)
    text = text.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Unordered lists
    text = text.replace(/^(?:[-*] .+\n?)+/gm, function (block) {
      var items = block.trim().split('\n').map(function (line) {
        return '<li>' + line.replace(/^[-*] /, '') + '</li>';
      }).join('');
      return '<ul>' + items + '</ul>';
    });

    // Ordered lists
    text = text.replace(/^(?:\d+\. .+\n?)+/gm, function (block) {
      var items = block.trim().split('\n').map(function (line) {
        return '<li>' + line.replace(/^\d+\. /, '') + '</li>';
      }).join('');
      return '<ol>' + items + '</ol>';
    });

    // Tables
    text = text.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, function (_, headerRow, sepRow, bodyRows) {
      var headers = headerRow.split('|').filter(function (c) { return c.trim(); });
      var rows = bodyRows.trim().split('\n');
      var thead = '<thead><tr>' + headers.map(function (h) { return '<th>' + h.trim() + '</th>'; }).join('') + '</tr></thead>';
      var tbody = '<tbody>' + rows.map(function (row) {
        var cells = row.split('|').filter(function (c) { return c.trim(); });
        return '<tr>' + cells.map(function (c) { return '<td>' + c.trim() + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody>';
      return '<table>' + thead + tbody + '</table>';
    });

    // Paragraphs: split by double newlines
    var parts = text.split(/\n\n+/);
    text = parts.map(function (p) {
      p = p.trim();
      if (!p) return '';
      if (/^<(h[1-6]|pre|ul|ol|blockquote|hr|table|div)/.test(p)) return p;
      return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');

    return text;
  }

  // ── Rendering ──
  function renderSidebar() {
    channelList.innerHTML = '';
    agents.forEach(function (agent) {
      var btn = document.createElement('button');
      btn.className = 'channel-item' + (agent.id === activeAgentId ? ' active' : '');
      btn.onclick = function () { switchAgent(agent.id); };

      var emoji = document.createElement('span');
      emoji.className = 'channel-emoji';
      emoji.textContent = agent.emoji;

      var name = document.createElement('span');
      name.className = 'channel-name';
      name.textContent = agent.name;

      btn.appendChild(emoji);
      btn.appendChild(name);

      if (agent.isMain) {
        var tag = document.createElement('span');
        tag.className = 'channel-main-tag';
        tag.textContent = 'main';
        btn.appendChild(tag);
      }

      if (agent.id !== activeAgentId && hasUnread(agent.id)) {
        var dot = document.createElement('span');
        dot.className = 'channel-unread';
        btn.appendChild(dot);
      }

      channelList.appendChild(btn);
    });
  }

  function renderHeader() {
    var agent = agents.find(function (a) { return a.id === activeAgentId; });
    if (agent) {
      headerEmoji.textContent = agent.emoji;
      headerName.textContent = agent.name;
      document.title = agent.name + ' - Chat';
    }
  }

  function renderMessages() {
    if (!activeAgentId) return;
    var thread = getActiveThread(activeAgentId);
    messagesEl.innerHTML = '';

    if (!thread || thread.messages.length === 0) {
      var agent = agents.find(function (a) { return a.id === activeAgentId; });
      var empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML =
        '<div class="empty-state-emoji">' + (agent ? agent.emoji : '') + '</div>' +
        '<h3>Start a conversation</h3>' +
        '<p>Send a message to ' + (agent ? agent.name : 'your assistant') + '</p>';
      messagesEl.appendChild(empty);
      return;
    }

    thread.messages.forEach(function (msg) {
      appendMessageEl(msg.role, msg.content);
    });

    scrollToBottom(true);
  }

  function appendMessageEl(role, content) {
    var div = document.createElement('div');
    if (role === 'user') {
      div.className = 'msg msg-user';
      div.textContent = content;
    } else if (role === 'error') {
      div.className = 'msg msg-error';
      div.textContent = content;
    } else {
      div.className = 'msg msg-agent';
      var inner = document.createElement('div');
      inner.className = 'msg-content';
      inner.innerHTML = renderMarkdown(content);
      div.appendChild(inner);
    }
    messagesEl.appendChild(div);
    return div;
  }

  function showTyping() {
    var div = document.createElement('div');
    div.className = 'typing-indicator';
    div.id = 'typing';
    div.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function hideTyping() {
    var el = document.getElementById('typing');
    if (el) el.remove();
  }

  function renderThreadPicker() {
    if (!activeAgentId) return;
    var data = loadAgentData(activeAgentId);
    threadListEl.innerHTML = '';

    if (data.threads.length === 0) {
      threadListEl.innerHTML = '<div style="padding:0.75rem;color:var(--text-dim);font-size:0.85rem;">No threads yet</div>';
      return;
    }

    data.threads.forEach(function (thread) {
      var btn = document.createElement('button');
      btn.className = 'thread-item' + (thread.id === data.activeThreadId ? ' active' : '');
      btn.onclick = function () { switchThread(thread.id); };

      var title = document.createElement('span');
      title.className = 'thread-title';
      title.textContent = thread.title || 'New conversation';

      var date = document.createElement('span');
      date.className = 'thread-date';
      date.textContent = formatDate(thread.updatedAt || thread.createdAt);

      btn.appendChild(title);
      btn.appendChild(date);
      threadListEl.appendChild(btn);
    });
  }

  function scrollToBottom(force) {
    var el = messagesEl;
    var nearBottom = force || (el.scrollHeight - el.scrollTop - el.clientHeight < 100);
    if (nearBottom) {
      requestAnimationFrame(function () {
        el.scrollTop = el.scrollHeight;
      });
    }
  }

  // ── Actions ──
  function switchAgent(agentId) {
    if (streaming) return;
    activeAgentId = agentId;
    ensureThread(agentId);
    markRead(agentId);
    renderSidebar();
    renderHeader();
    renderMessages();
    closeSidebar();
    threadPicker.hidden = true;
    msgInput.focus();
  }

  function switchThread(threadId) {
    if (streaming) return;
    var data = loadAgentData(activeAgentId);
    data.activeThreadId = threadId;
    saveAgentData(activeAgentId, data);
    renderMessages();
    renderThreadPicker();
    threadPicker.hidden = true;
    msgInput.focus();
  }

  function newThread() {
    if (streaming) return;
    var data = loadAgentData(activeAgentId);
    var thread = { id: genId(), title: 'New conversation', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    data.threads.unshift(thread);
    data.activeThreadId = thread.id;
    saveAgentData(activeAgentId, data);
    renderMessages();
    renderThreadPicker();
    msgInput.focus();
  }

  function openSidebar() {
    sidebar.classList.add('open');
    overlay.hidden = false;
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.hidden = true;
  }

  // ── Send message with streaming ──
  async function sendMessage() {
    var text = msgInput.value.trim();
    if (!text || streaming) return;

    var agentId = activeAgentId;
    var data = ensureThread(agentId);
    var threadId = data.activeThreadId;

    // Clear input
    msgInput.value = '';
    autoResize();
    btnSend.disabled = true;

    // Add user message
    addMessage(agentId, threadId, 'user', text);
    appendMessageEl('user', text);
    scrollToBottom(true);

    // Build messages array for API
    var thread = getActiveThread(agentId);
    var apiMessages = thread.messages.map(function (m) {
      return { role: m.role, content: m.content };
    });

    // Show typing indicator
    showTyping();
    streaming = true;

    var fullText = '';
    var streamEl = null;

    try {
      var res = await fetch('/portal/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ agent: agentId, messages: apiMessages })
      });

      if (res.status === 401) {
        window.location.href = '/portal/';
        return;
      }

      if (!res.ok) {
        throw new Error('Request failed: ' + res.status);
      }

      hideTyping();

      // Create streaming message element
      streamEl = document.createElement('div');
      streamEl.className = 'msg msg-agent';
      var contentEl = document.createElement('div');
      contentEl.className = 'msg-content';
      streamEl.appendChild(contentEl);
      messagesEl.appendChild(streamEl);

      // Read SSE stream
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var lastRender = 0;

      while (true) {
        var result = await reader.read();
        if (result.done) break;

        buffer += decoder.decode(result.value, { stream: true });

        // Parse SSE events from buffer
        var lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line.startsWith('data: ')) continue;
          var jsonStr = line.slice(6);
          if (jsonStr === '[DONE]') continue;

          try {
            var event = JSON.parse(jsonStr);

            if (event.type === 'error') {
              throw new Error((event.error && event.error.message) || event.error || 'Stream error');
            }

            // Extract text delta — handle multiple gateway formats
            var delta = '';
            // OpenAI chat completions format (OpenClaw gateway)
            if (event.choices && event.choices[0] && event.choices[0].delta && typeof event.choices[0].delta.content === 'string') {
              delta = event.choices[0].delta.content;
            }
            // Anthropic streaming formats
            else if (event.type === 'content_block_delta' && event.delta && typeof event.delta.text === 'string') {
              delta = event.delta.text;
            } else if (event.type === 'content_block_start' && event.content_block && typeof event.content_block.text === 'string') {
              delta = event.content_block.text;
            } else if (event.type === 'message_delta' && event.delta && typeof event.delta.text === 'string') {
              delta = event.delta.text;
            } else if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
              delta = event.delta;
            } else if (typeof event.completion === 'string') {
              delta = event.completion;
            }
            // OpenAI non-streaming format (full message)
            else if (event.choices && event.choices[0] && event.choices[0].message && typeof event.choices[0].message.content === 'string') {
              delta = event.choices[0].message.content;
            }

            if (delta) fullText += delta;
          } catch (parseErr) {
            if (parseErr.message && !parseErr.message.includes('JSON')) {
              throw parseErr;
            }
            // Ignore JSON parse errors from partial data
          }
        }

        // Throttle DOM updates to ~30fps
        var now = Date.now();
        if (now - lastRender > 33 && fullText) {
          contentEl.innerHTML = renderMarkdown(fullText);
          scrollToBottom();
          lastRender = now;
        }
      }

      // Final render
      if (fullText) {
        contentEl.innerHTML = renderMarkdown(fullText);
        addMessage(agentId, threadId, 'assistant', fullText);
        scrollToBottom(true);
      } else {
        // No content received
        streamEl.remove();
        appendMessageEl('error', 'No response received. Try again.');
      }

    } catch (err) {
      hideTyping();
      if (streamEl) streamEl.remove();
      appendMessageEl('error', 'Failed to send: ' + (err.message || 'Unknown error'));
      scrollToBottom(true);
    } finally {
      streaming = false;
      btnSend.disabled = !msgInput.value.trim();
    }
  }

  // ── Input auto-resize ──
  function autoResize() {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    btnSend.disabled = !msgInput.value.trim() || streaming;
  }

  // ── Register service worker ──
  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/portal/sw.js', { scope: '/portal/' }).catch(function () {
        // SW registration failed, non-critical
      });
    }
  }

  // ── Init ──
  async function init() {
    registerSW();

    // Check auth
    var authed = await checkAuth();
    if (!authed) {
      window.location.href = '/portal/';
      return;
    }

    // Fetch agents
    try {
      agents = await fetchAgents();
    } catch (err) {
      messagesEl.innerHTML =
        '<div class="empty-state">' +
        '<div class="empty-state-emoji">&#x26A0;&#xFE0F;</div>' +
        '<h3>Failed to load</h3>' +
        '<p>Could not connect to the server. <a href="" style="color:var(--accent)">Retry</a></p>' +
        '</div>';
      return;
    }

    if (agents.length === 0) {
      agents = [{ id: 'main', name: 'Assistant', emoji: '\u{1F916}', isMain: true }];
    }

    // Default to main agent
    var mainAgent = agents.find(function (a) { return a.isMain; }) || agents[0];
    activeAgentId = mainAgent.id;
    ensureThread(activeAgentId);
    markRead(activeAgentId);

    // Render
    renderSidebar();
    renderHeader();
    renderMessages();

    // ── Event bindings ──

    // Sidebar toggle
    $('#btn-hamburger').addEventListener('click', openSidebar);
    $('#btn-close-sidebar').addEventListener('click', closeSidebar);
    overlay.addEventListener('click', closeSidebar);

    // Thread controls
    $('#btn-new-thread').addEventListener('click', newThread);
    $('#btn-threads').addEventListener('click', function () {
      var showing = !threadPicker.hidden;
      threadPicker.hidden = showing;
      if (!showing) renderThreadPicker();
    });
    $('#btn-close-threads').addEventListener('click', function () {
      threadPicker.hidden = true;
    });

    // Input
    msgInput.addEventListener('input', autoResize);
    msgInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    btnSend.addEventListener('click', sendMessage);

    // Focus input
    msgInput.focus();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
