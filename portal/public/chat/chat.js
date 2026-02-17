(function () {
  const STORAGE_KEY = 'clawdaddy_pwa_chat_v1';

  const state = {
    botName: 'Assistant',
    channels: [],
    activeChannelId: null,
    threadsByChannel: {},
    activeThreadIdByChannel: {},
    isSending: false,
    isTyping: false,
    drawerOpen: false,
    installPromptEvent: null,
  };

  const elements = {};

  function uid(prefix) {
    return (
      (prefix || 'id') +
      '_' +
      Date.now().toString(36) +
      '_' +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderInlineMarkdown(text) {
    let html = text;
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    return html;
  }

  function markdownToHtml(markdown) {
    if (!markdown) return '';

    const codeBlocks = [];
    let text = String(markdown).replace(/\r\n/g, '\n');

    text = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      const index = codeBlocks.length;
      const classAttr = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
      codeBlocks.push(
        '<pre><code' + classAttr + '>' + escapeHtml(code.trimEnd()) + '</code></pre>',
      );
      return '@@CODE_BLOCK_' + index + '@@';
    });

    text = escapeHtml(text);

    const lines = text.split('\n');
    const chunks = [];
    let i = 0;

    function isBlockStart(line) {
      return (
        /^#{1,3}\s+/.test(line) ||
        /^>\s?/.test(line) ||
        /^[-*]\s+/.test(line) ||
        /^\d+\.\s+/.test(line) ||
        /^@@CODE_BLOCK_\d+@@$/.test(line)
      );
    }

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }

      if (/^@@CODE_BLOCK_\d+@@$/.test(line.trim())) {
        chunks.push(line.trim());
        i += 1;
        continue;
      }

      const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        chunks.push(
          '<h' + level + '>' + renderInlineMarkdown(headingMatch[2].trim()) + '</h' + level + '>',
        );
        i += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, '').trim());
          i += 1;
        }
        chunks.push('<blockquote>' + renderInlineMarkdown(quoteLines.join('<br>')) + '</blockquote>');
        continue;
      }

      if (/^[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items.push('<li>' + renderInlineMarkdown(lines[i].replace(/^[-*]\s+/, '').trim()) + '</li>');
          i += 1;
        }
        chunks.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      if (/^\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          items.push('<li>' + renderInlineMarkdown(lines[i].replace(/^\d+\.\s+/, '').trim()) + '</li>');
          i += 1;
        }
        chunks.push('<ol>' + items.join('') + '</ol>');
        continue;
      }

      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        paragraph.push(lines[i].trim());
        i += 1;
      }
      chunks.push('<p>' + renderInlineMarkdown(paragraph.join('<br>')) + '</p>');
    }

    let html = chunks.join('');
    html = html.replace(/@@CODE_BLOCK_(\d+)@@/g, function (_, idx) {
      return codeBlocks[Number(idx)] || '';
    });

    return html;
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    try {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  function channelById(channelId) {
    return state.channels.find(function (channel) {
      return channel.id === channelId;
    }) || null;
  }

  function getThreads(channelId) {
    return state.threadsByChannel[channelId] || [];
  }

  function getActiveThread(channelId) {
    const id = channelId || state.activeChannelId;
    const threads = getThreads(id);
    const activeThreadId = state.activeThreadIdByChannel[id];
    return threads.find(function (thread) {
      return thread.id === activeThreadId;
    }) || threads[0] || null;
  }

  function defaultThread(title) {
    const now = Date.now();
    return {
      id: uid('thread'),
      title: title || 'General',
      unread: 0,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  function channelUnreadCount(channelId) {
    return getThreads(channelId).reduce(function (sum, thread) {
      return sum + (Number(thread.unread) || 0);
    }, 0);
  }

  function normalizeStoredThread(thread) {
    if (!thread || typeof thread !== 'object') {
      return defaultThread('General');
    }

    const now = Date.now();
    const messages = Array.isArray(thread.messages)
      ? thread.messages
          .map(function (msg) {
            if (!msg || typeof msg !== 'object') return null;
            const role = msg.role === 'assistant' ? 'assistant' : 'user';
            const content = typeof msg.content === 'string' ? msg.content : '';
            if (!content.trim()) return null;
            return {
              id: msg.id || uid(role),
              role: role,
              content: content,
              timestamp: Number(msg.timestamp) || now,
            };
          })
          .filter(Boolean)
      : [];

    return {
      id: thread.id || uid('thread'),
      title: typeof thread.title === 'string' && thread.title.trim() ? thread.title : 'General',
      unread: Number(thread.unread) || 0,
      createdAt: Number(thread.createdAt) || now,
      updatedAt: Number(thread.updatedAt) || now,
      messages: messages,
    };
  }

  function loadLocalState(defaultChannelId) {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      stored = {};
    }

    const storedThreadsByChannel = stored.threadsByChannel || {};
    const storedActiveByChannel = stored.activeThreadIdByChannel || {};

    state.threadsByChannel = {};
    state.activeThreadIdByChannel = {};

    state.channels.forEach(function (channel) {
      const rawThreads = Array.isArray(storedThreadsByChannel[channel.id])
        ? storedThreadsByChannel[channel.id]
        : [];

      const threads = rawThreads.map(normalizeStoredThread);
      if (threads.length === 0) {
        threads.push(defaultThread('General'));
      }

      state.threadsByChannel[channel.id] = threads;

      const requestedActive = storedActiveByChannel[channel.id];
      const hasRequested = threads.some(function (thread) {
        return thread.id === requestedActive;
      });

      state.activeThreadIdByChannel[channel.id] = hasRequested
        ? requestedActive
        : threads[0].id;
    });

    const validActiveChannel = state.channels.some(function (channel) {
      return channel.id === stored.activeChannelId;
    });

    state.activeChannelId = validActiveChannel
      ? stored.activeChannelId
      : defaultChannelId || (state.channels[0] ? state.channels[0].id : null);

    clearUnreadForActiveView();
  }

  function saveLocalState() {
    const payload = {
      activeChannelId: state.activeChannelId,
      activeThreadIdByChannel: state.activeThreadIdByChannel,
      threadsByChannel: state.threadsByChannel,
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // local storage can fail in private mode; continue without persistence
    }
  }

  function clearUnreadForActiveView() {
    const activeThread = getActiveThread();
    if (!activeThread) return;
    activeThread.unread = 0;
    saveLocalState();
  }

  function setDrawerOpen(open) {
    state.drawerOpen = !!open;
    elements.app.classList.toggle('drawer-open', state.drawerOpen);
    elements.drawerScrim.hidden = !state.drawerOpen;
  }

  function renderChannels() {
    const fragment = document.createDocumentFragment();

    state.channels.forEach(function (channel) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'channel-btn' + (channel.id === state.activeChannelId ? ' active' : '');
      button.dataset.channelId = channel.id;

      const unread = channelUnreadCount(channel.id);
      button.innerHTML =
        '<span class="channel-main">' +
        '<span aria-hidden="true">' + escapeHtml(channel.emoji || '🤖') + '</span>' +
        '<span class="channel-name">' + escapeHtml(channel.name) + '</span>' +
        '</span>' +
        (unread > 0
          ? '<span class="unread-badge" aria-label="' + unread + ' unread">' + unread + '</span>'
          : '');

      fragment.appendChild(button);
    });

    elements.channelList.innerHTML = '';
    elements.channelList.appendChild(fragment);
  }

  function renderHeader() {
    const channel = channelById(state.activeChannelId);
    if (!channel) return;

    elements.botName.textContent = state.botName;
    elements.activeChannelName.textContent = channel.emoji + ' ' + channel.name;

    const thread = getActiveThread(channel.id);
    const messageCount = thread ? thread.messages.length : 0;
    elements.activeChannelSubtitle.textContent =
      messageCount > 0 ? messageCount + ' messages' : 'No messages yet';
  }

  function renderThreadSelect() {
    const channelId = state.activeChannelId;
    const threads = getThreads(channelId);

    elements.threadSelect.innerHTML = '';

    threads.forEach(function (thread) {
      const option = document.createElement('option');
      option.value = thread.id;
      option.textContent =
        thread.title + (thread.unread > 0 ? ' (' + String(thread.unread) + ')' : '');
      elements.threadSelect.appendChild(option);
    });

    const activeThread = getActiveThread(channelId);
    if (activeThread) {
      elements.threadSelect.value = activeThread.id;
    }
  }

  function shouldAutoscroll() {
    const el = elements.messageList;
    const slack = 90;
    return el.scrollHeight - el.scrollTop - el.clientHeight < slack;
  }

  function scrollMessagesToBottom(force) {
    if (force || shouldAutoscroll()) {
      elements.messageList.scrollTop = elements.messageList.scrollHeight;
    }
  }

  function renderMessages(forceScroll) {
    const activeThread = getActiveThread();
    if (!activeThread) {
      elements.messageList.innerHTML =
        '<div class="empty-state">No thread selected yet.</div>';
      return;
    }

    if (!activeThread.messages.length) {
      elements.messageList.innerHTML =
        '<div class="empty-state">Start the conversation. Press Enter to send, Shift+Enter for a new line.</div>';
      return;
    }

    const activeChannel = channelById(state.activeChannelId);
    const agentLabel = activeChannel
      ? activeChannel.emoji + ' ' + activeChannel.name
      : 'Assistant';

    const html = activeThread.messages
      .map(function (message) {
        const isUser = message.role === 'user';
        const roleClass = isUser ? 'user' : 'assistant';
        const metaLabel = isUser ? 'You' : agentLabel;
        const content = isUser
          ? '<p>' + escapeHtml(message.content).replace(/\n/g, '<br>') + '</p>'
          : markdownToHtml(message.content);

        return (
          '<div class="message-row ' + roleClass + '">' +
          '<article class="message-bubble" aria-label="' + roleClass + ' message">' +
          '<div class="message-meta">' +
          escapeHtml(metaLabel) +
          (message.timestamp ? ' · ' + escapeHtml(formatTime(message.timestamp)) : '') +
          '</div>' +
          '<div class="message-content">' +
          content +
          '</div>' +
          '</article>' +
          '</div>'
        );
      })
      .join('');

    elements.messageList.innerHTML = html;
    scrollMessagesToBottom(forceScroll === true);
  }

  function renderTypingIndicator() {
    elements.typingIndicator.hidden = !state.isTyping;
  }

  function render() {
    renderChannels();
    renderHeader();
    renderThreadSelect();
    renderMessages(false);
    renderTypingIndicator();
  }

  function setComposerBusy(busy) {
    state.isSending = !!busy;
    elements.messageInput.disabled = state.isSending;
    elements.sendBtn.disabled = state.isSending;
    elements.newThreadBtn.disabled = state.isSending;
  }

  function setOnlineStatus() {
    const isOnline = navigator.onLine;
    elements.offlineBanner.hidden = isOnline;
  }

  function updateThreadTitleFromMessage(thread, text) {
    if (!thread || thread.title !== 'General') return;
    const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
    if (!collapsed) return;
    thread.title = collapsed.slice(0, 48);
  }

  function addMessage(channelId, threadId, role, content) {
    const threads = getThreads(channelId);
    const thread = threads.find(function (item) {
      return item.id === threadId;
    });
    if (!thread) return null;

    const now = Date.now();
    const message = {
      id: uid(role),
      role: role,
      content: content,
      timestamp: now,
    };

    thread.messages.push(message);
    thread.updatedAt = now;

    if (role === 'user') {
      updateThreadTitleFromMessage(thread, content);
    }

    return message;
  }

  function parseSseEvents(chunk, onEvent) {
    const segments = chunk.split(/\r?\n\r?\n/);
    const remainder = segments.pop() || '';

    segments.forEach(function (segment) {
      const lines = segment.split(/\r?\n/);
      const dataLines = lines
        .filter(function (line) {
          return line.startsWith('data:');
        })
        .map(function (line) {
          return line.slice(5).trim();
        });

      if (!dataLines.length) return;

      const data = dataLines.join('');
      if (!data || data === '[DONE]') {
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }

      onEvent(parsed);
    });

    return remainder;
  }

  function extractDeltaText(event) {
    if (!event || typeof event !== 'object') return '';

    if (event.type === 'content_block_delta' && event.delta && typeof event.delta.text === 'string') {
      return event.delta.text;
    }

    if (
      event.type === 'content_block_start' &&
      event.content_block &&
      typeof event.content_block.text === 'string'
    ) {
      return event.content_block.text;
    }

    if (event.type === 'message_delta' && event.delta && typeof event.delta.text === 'string') {
      return event.delta.text;
    }

    if (typeof event.completion === 'string') {
      return event.completion;
    }

    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      return event.delta;
    }

    return '';
  }

  async function streamAssistantReply(channelId, threadId, assistantMessage) {
    const thread = getThreads(channelId).find(function (item) {
      return item.id === threadId;
    });

    if (!thread) {
      throw new Error('Thread no longer exists');
    }

    const payload = {
      channelId: channelId,
      threadId: threadId,
      messages: thread.messages
        .filter(function (msg) {
          return msg.id !== assistantMessage.id;
        })
        .map(function (msg) {
          return {
            role: msg.role,
            content: msg.content,
          };
        }),
    };

    const res = await fetch('/portal/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });

    if (res.status === 401) {
      window.location.href = '/portal/';
      return;
    }

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body.error || body.detail || '';
      } catch {
        detail = await res.text();
      }
      throw new Error(detail || 'Failed to stream response');
    }

    if (!res.body) {
      throw new Error('Missing stream body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    let sawText = false;
    let unreadMarked = false;

    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      buffer = parseSseEvents(buffer, function (event) {
        if (event.type === 'error') {
          const message = event.error && event.error.message
            ? event.error.message
            : 'Gateway streaming error';
          throw new Error(message);
        }

        const delta = extractDeltaText(event);
        if (!delta) {
          return;
        }

        if (!sawText) {
          sawText = true;
          state.isTyping = false;
        }

        assistantMessage.content += delta;

        const isActiveThread =
          state.activeChannelId === channelId &&
          state.activeThreadIdByChannel[channelId] === threadId;

        if (!isActiveThread && !unreadMarked) {
          thread.unread += 1;
          unreadMarked = true;
        }

        renderChannels();
        renderHeader();
        renderMessages(true);
      });
    }

    if (buffer.trim()) {
      parseSseEvents(buffer + '\n\n', function (event) {
        const delta = extractDeltaText(event);
        if (!delta) return;
        if (!sawText) state.isTyping = false;
        sawText = true;
        assistantMessage.content += delta;
      });
    }

    if (!assistantMessage.content.trim()) {
      assistantMessage.content = 'No content returned.';
    }
  }

  async function handleSend(event) {
    event.preventDefault();
    if (state.isSending) return;

    const text = elements.messageInput.value.replace(/\r\n/g, '\n').trim();
    if (!text) return;

    const channelId = state.activeChannelId;
    const thread = getActiveThread(channelId);
    if (!thread) return;

    const isActiveBefore = shouldAutoscroll();

    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto';

    addMessage(channelId, thread.id, 'user', text);
    const assistantMessage = addMessage(channelId, thread.id, 'assistant', '');

    saveLocalState();
    state.isTyping = true;
    render();
    if (isActiveBefore) {
      scrollMessagesToBottom(true);
    }

    setComposerBusy(true);

    try {
      await streamAssistantReply(channelId, thread.id, assistantMessage);
    } catch (err) {
      const message = err && err.message ? err.message : 'Unknown error';
      assistantMessage.content =
        (assistantMessage.content ? assistantMessage.content + '\n\n' : '') +
        '_Error: ' + message + '_';
    } finally {
      state.isTyping = false;
      setComposerBusy(false);
      saveLocalState();
      render();
      elements.messageInput.focus();
    }
  }

  function createNewThread() {
    if (!state.activeChannelId) return;

    const newThread = defaultThread('General');
    state.threadsByChannel[state.activeChannelId].unshift(newThread);
    state.activeThreadIdByChannel[state.activeChannelId] = newThread.id;

    saveLocalState();
    render();
    elements.messageInput.focus();
  }

  function switchChannel(channelId) {
    if (!channelById(channelId)) return;

    state.activeChannelId = channelId;
    clearUnreadForActiveView();
    setDrawerOpen(false);
    render();
  }

  function switchThread(threadId) {
    const channelId = state.activeChannelId;
    const thread = getThreads(channelId).find(function (item) {
      return item.id === threadId;
    });
    if (!thread) return;

    state.activeThreadIdByChannel[channelId] = threadId;
    thread.unread = 0;
    saveLocalState();
    render();
    scrollMessagesToBottom(true);
  }

  async function checkAuth() {
    try {
      const res = await fetch('/portal/api/auth/check', {
        credentials: 'same-origin',
      });
      const data = await res.json();
      return !!data.authenticated;
    } catch {
      return false;
    }
  }

  async function bootstrapChat() {
    const authed = await checkAuth();
    if (!authed) {
      window.location.href = '/portal/';
      return;
    }

    const res = await fetch('/portal/api/chat/bootstrap', {
      credentials: 'same-origin',
    });

    if (res.status === 401) {
      window.location.href = '/portal/';
      return;
    }

    if (!res.ok) {
      throw new Error('Failed to load chat channels');
    }

    const data = await res.json();
    state.botName = data.botName || 'Assistant';
    state.channels = Array.isArray(data.channels) ? data.channels : [];

    if (!state.channels.length) {
      state.channels = [
        {
          id: 'main',
          name: state.botName,
          emoji: '🦞',
          isMain: true,
        },
      ];
    }

    loadLocalState(data.defaultChannelId || 'main');
    saveLocalState();
    render();
    scrollMessagesToBottom(true);
  }

  function bindEvents() {
    elements.channelList.addEventListener('click', function (event) {
      const button = event.target.closest('[data-channel-id]');
      if (!button) return;
      switchChannel(button.dataset.channelId);
    });

    elements.menuBtn.addEventListener('click', function () {
      setDrawerOpen(true);
    });

    elements.drawerScrim.addEventListener('click', function () {
      setDrawerOpen(false);
    });

    elements.threadSelect.addEventListener('change', function (event) {
      switchThread(event.target.value);
    });

    elements.newThreadBtn.addEventListener('click', createNewThread);

    elements.composer.addEventListener('submit', handleSend);

    elements.messageInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        elements.composer.requestSubmit();
      }
    });

    elements.messageInput.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 176) + 'px';
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth >= 900) {
        setDrawerOpen(false);
      }
    });

    window.addEventListener('online', setOnlineStatus);
    window.addEventListener('offline', setOnlineStatus);
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    try {
      await navigator.serviceWorker.register('/portal/sw.js', { scope: '/portal/' });
    } catch {
      // service worker registration is best-effort
    }
  }

  function setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      state.installPromptEvent = event;
      elements.installBtn.hidden = false;
    });

    elements.installBtn.addEventListener('click', async function () {
      if (!state.installPromptEvent) return;
      state.installPromptEvent.prompt();
      try {
        await state.installPromptEvent.userChoice;
      } catch {
        // no-op
      }
      state.installPromptEvent = null;
      elements.installBtn.hidden = true;
    });

    window.addEventListener('appinstalled', function () {
      state.installPromptEvent = null;
      elements.installBtn.hidden = true;
    });
  }

  function cacheElements() {
    elements.app = document.getElementById('app');
    elements.sidebar = document.getElementById('sidebar');
    elements.drawerScrim = document.getElementById('drawer-scrim');
    elements.botName = document.getElementById('bot-name');
    elements.channelList = document.getElementById('channel-list');
    elements.activeChannelName = document.getElementById('active-channel-name');
    elements.activeChannelSubtitle = document.getElementById('active-channel-subtitle');
    elements.menuBtn = document.getElementById('menu-btn');
    elements.installBtn = document.getElementById('install-btn');
    elements.threadSelect = document.getElementById('thread-select');
    elements.newThreadBtn = document.getElementById('new-thread-btn');
    elements.offlineBanner = document.getElementById('offline-banner');
    elements.messageList = document.getElementById('message-list');
    elements.typingIndicator = document.getElementById('typing-indicator');
    elements.composer = document.getElementById('composer');
    elements.messageInput = document.getElementById('message-input');
    elements.sendBtn = document.getElementById('send-btn');
  }

  async function init() {
    cacheElements();
    bindEvents();
    setupInstallPrompt();
    setOnlineStatus();
    await registerServiceWorker();

    try {
      await bootstrapChat();
      elements.messageInput.focus();
    } catch (err) {
      const message = err && err.message ? err.message : 'Failed to initialize chat';
      elements.messageList.innerHTML =
        '<div class="empty-state">' + escapeHtml(message) + '</div>';
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
