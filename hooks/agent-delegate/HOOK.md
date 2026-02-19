# agent-delegate

Internal delegation hook pack for OpenClaw.

## Purpose

This hook routes agent delegation through OpenClaw's **internal** command path (`agentCommand` or equivalent), instead of calling `/hooks/agent` over HTTP.

That avoids `EXTERNAL_UNTRUSTED_CONTENT` wrapping for this route and enforces explicit Discord delivery targeting.

## Required input

- `prompt` (or `message`/`text`)
- `to` (Discord channel id)

## Optional input

- `sessionKey` (target agent session key; if omitted, runtime default applies)
- `channel` (defaults to `discord`)
- `deliver` (defaults to `true`)
- `model`
- `metadata`

## Behavior

- Hard-fails when `to` is missing (`MISSING_TARGET_CHANNEL`)
- Hard-fails when prompt is missing (`MISSING_PROMPT`)
- Hard-fails if internal command path is unavailable (`AGENT_COMMAND_UNAVAILABLE`)
- Emits concise logs for route, target, and errors

## Security / routing

This pack always sets explicit delivery fields:

- `deliver: true` (unless explicitly overridden)
- `channel: 'discord'` (unless explicitly overridden)
- `to: '<channel-id>'` (required)

So responses are routed to the intended Discord channel and do not bleed into a DM/main session.
