'use strict';

/**
 * Agent Delegate hook pack
 *
 * Routes delegation through OpenClaw's internal agent command path
 * (agentCommand / equivalent), with explicit Discord delivery targeting.
 */

function stringifyError(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  if (error.stack) return error.stack;
  if (error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function resolveContextApi(ctx) {
  const candidate =
    ctx?.api ||
    ctx?.runtime ||
    ctx?.services ||
    ctx?.openclaw ||
    ctx;

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
  if (ctx?.logger) return ctx.logger;
  return console;
}

function normalizeInput(ctx) {
  const input = ctx?.input || ctx?.body || ctx?.payload || {};

  const sessionKey = input.sessionKey || input.session || input.targetSession || undefined;
  const to = input.to || input.channelId || input.discordChannelId || input.targetChannelId || undefined;
  const prompt = input.prompt || input.message || input.text || '';

  return {
    raw: input,
    sessionKey,
    to,
    prompt,
    channel: input.channel || 'discord',
    deliver: input.deliver !== undefined ? Boolean(input.deliver) : true,
    model: input.model,
    metadata: input.metadata || {},
  };
}

module.exports = async function agentDelegateHook(ctx = {}) {
  const log = loggerFor(ctx);
  const { raw, sessionKey, to, prompt, channel, deliver, model, metadata } = normalizeInput(ctx);

  if (!to) {
    const msg = '[agent-delegate] Missing required target channel: provide `to` (Discord channel id).';
    log.warn(msg, { sessionKey, channel, deliver, hasPrompt: Boolean(prompt) });
    const error = new Error(msg);
    error.code = 'MISSING_TARGET_CHANNEL';
    throw error;
  }

  if (!prompt || !String(prompt).trim()) {
    const msg = '[agent-delegate] Missing required prompt/message.';
    log.warn(msg, { sessionKey, to, channel, deliver });
    const error = new Error(msg);
    error.code = 'MISSING_PROMPT';
    throw error;
  }

  const resolved = resolveContextApi(ctx);
  if (!resolved?.agentCommand) {
    const msg = '[agent-delegate] No internal agent command function found (expected `agentCommand`).';
    log.error(msg, { contextKeys: Object.keys(ctx || {}) });
    const error = new Error(msg);
    error.code = 'AGENT_COMMAND_UNAVAILABLE';
    throw error;
  }

  const commandInput = {
    prompt,
    deliver,
    channel,
    to,
    model,
    metadata: {
      ...metadata,
      routedBy: 'hook:agent-delegate',
      transport: 'internal-agent-command',
    },
  };

  if (sessionKey) {
    commandInput.sessionKey = sessionKey;
  }

  log.info('[agent-delegate] route=internal-agent-command dispatching', {
    sessionKey: sessionKey || '(default)',
    to,
    channel,
    deliver,
    model: model || '(default)',
  });

  try {
    const result = await resolved.agentCommand(commandInput);

    log.info('[agent-delegate] route=internal-agent-command dispatched', {
      ok: true,
      to,
      sessionKey: sessionKey || '(default)',
      resultType: typeof result,
      hasResult: result !== undefined,
    });

    return {
      ok: true,
      route: 'internal-agent-command',
      delivery: { deliver, channel, to },
      sessionKey: sessionKey || null,
      result,
    };
  } catch (error) {
    log.error('[agent-delegate] route=internal-agent-command failed', {
      to,
      channel,
      sessionKey: sessionKey || '(default)',
      error: stringifyError(error),
    });
    throw error;
  }
};
