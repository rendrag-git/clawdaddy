# Agent Delegate Hook Pack (internal routing)

This document covers the additive `hooks/agent-delegate` pack.

## Goal

Use OpenClaw internal `agentCommand` routing for agent-to-agent delegation, with explicit Discord delivery target:

- `deliver: true`
- `channel: "discord"`
- `to: "<discord-channel-id>"`

This avoids `/hooks/agent` HTTP transport and avoids `EXTERNAL_UNTRUSTED_CONTENT` wrapper behavior for this route.

## Config

1. Install/enable the hook pack from `hooks/agent-delegate/`.
2. Keep existing `/hooks/agent` as-is (no breaking changes).
3. If callers may omit `sessionKey`, set a default session in hook config (for example):

```json
{
  "hooks": {
    "defaultSessionKey": "dev"
  }
}
```

> Exact registration shape depends on your OpenClaw runtime wiring. The important part is: `agent-delegate` executes internally and receives `sessionKey`, `prompt`, and `to`.

## Operational guidance

- Require `to` (Discord channel id) in automation payloads.
- Prefer explicit `sessionKey` for production routes.
- Monitor logs for `[agent-delegate] route=internal-agent-command` entries.
