'use strict';

/**
 * Agent Delegate hook pack
 *
 * Listens on message:received events but ONLY acts when the message
 * contains an explicit delegation marker. Normal messages pass through silently.
 *
 * Delegation marker: message content starts with [DELEGATE] or metadata contains
 * { delegate: true } or { routedBy: 'hook:agent-delegate' }.
 */

const DELEGATE_PREFIX = '[DELEGATE]';

function isDelegationRequest(event) {
  // Check content prefix
  const content = event?.context?.content || '';
  if (content.startsWith(DELEGATE_PREFIX)) return true;

  // Check metadata flags
  const meta = event?.context?.metadata || {};
  if (meta.delegate === true) return true;
  if (meta.routedBy === 'hook:agent-delegate') return true;

  return false;
}

function parseDelegationContent(content) {
  // Strip [DELEGATE] prefix and parse structured fields
  // Format: [DELEGATE] to=<channelId> session=<key> model=<model> | <prompt>
  const body = content.slice(DELEGATE_PREFIX.length).trim();
  const pipeIdx = body.indexOf('|');
  const headerPart = pipeIdx >= 0 ? body.slice(0, pipeIdx).trim() : '';
  const prompt = pipeIdx >= 0 ? body.slice(pipeIdx + 1).trim() : body;

  const fields = {};
  for (const token of headerPart.split(/\s+/)) {
    const eqIdx = token.indexOf('=');
    if (eqIdx > 0) {
      fields[token.slice(0, eqIdx)] = token.slice(eqIdx + 1);
    }
  }

  return {
    to: fields.to || fields.channel || undefined,
    sessionKey: fields.session || fields.sessionKey || undefined,
    model: fields.model || undefined,
    prompt,
    channel: fields.provider || 'discord',
    deliver: true,
  };
}

function stringifyError(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  if (error.stack) return error.stack;
  if (error.message) return error.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function resolveContextApi(ctx) {
  const candidate = ctx?.api || ctx?.runtime || ctx?.services || ctx?.openclaw || ctx;
  if (!candidate) return null;

  const agentCommand =
    typeof candidate.agentCommand === 'function'
      ? candidate.agentCommand.bind(candidate)
      : typeof candidate.command === 'function'
        ? candidate.command.bind(candidate)
        : null;

  return { candidate, agentCommand };
}

function loggerFor(ctx) {
  return ctx?.logger || console;
}

module.exports = async function agentDelegateHook(event = {}) {
  const log = loggerFor(event);

  // CRITICAL: silently skip non-delegation messages
  if (!isDelegationRequest(event)) {
    return; // pass through — not a delegation
  }

  log.info('[agent-delegate] delegation request detected');

  // Parse delegation parameters from message content or metadata
  const content = event?.context?.content || '';
  const meta = event?.context?.metadata || {};

  let params;
  if (content.startsWith(DELEGATE_PREFIX)) {
    params = parseDelegationContent(content);
  } else {
    // Metadata-driven delegation
    params = {
      to: meta.to || meta.channelId || meta.targetChannelId,
      sessionKey: meta.sessionKey || meta.session,
      model: meta.model,
      prompt: meta.prompt || meta.message || content,
      channel: meta.channel || 'discord',
      deliver: meta.deliver !== undefined ? Boolean(meta.deliver) : true,
    };
  }

  const { to, sessionKey, model, prompt, channel, deliver } = params;

  if (!to) {
    log.warn('[agent-delegate] Delegation missing target channel (to). Skipping.');
    return; // don't throw — just skip gracefully
  }

  if (!prompt || !String(prompt).trim()) {
    log.warn('[agent-delegate] Delegation missing prompt. Skipping.');
    return;
  }

  const resolved = resolveContextApi(event);
  if (!resolved?.agentCommand) {
    log.error('[agent-delegate] No internal agentCommand function available.', {
      contextKeys: Object.keys(event || {}),
    });
    return;
  }

  const commandInput = {
    prompt,
    deliver,
    channel,
    to,
    model,
    metadata: {
      routedBy: 'hook:agent-delegate',
      transport: 'internal-agent-command',
    },
  };

  if (sessionKey) commandInput.sessionKey = sessionKey;

  log.info('[agent-delegate] dispatching', {
    to, channel, deliver,
    sessionKey: sessionKey || '(default)',
    model: model || '(default)',
    promptLength: prompt.length,
  });

  try {
    const result = await resolved.agentCommand(commandInput);
    log.info('[agent-delegate] dispatched OK', { to, sessionKey: sessionKey || '(default)' });
    return { ok: true, route: 'internal-agent-command', to, result };
  } catch (error) {
    log.error('[agent-delegate] dispatch failed', {
      to, error: stringifyError(error),
    });
    // Don't throw — log and move on so we don't break message processing
  }
};
