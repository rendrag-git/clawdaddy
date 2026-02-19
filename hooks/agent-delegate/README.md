# agent-delegate hook pack

Additive hook pack to delegate agent work via OpenClaw internal `agentCommand` routing.

## Why

- Avoid `/hooks/agent` HTTP delegation path
- Avoid `EXTERNAL_UNTRUSTED_CONTENT` wrapper on legitimate internal delegations
- Force explicit Discord delivery target (`deliver/channel/to`)

## Usage examples

### A) agent -> agent into a target channel

```json
{
  "sessionKey": "payments",
  "prompt": "Review failed checkout events from the last 2 hours.",
  "deliver": true,
  "channel": "discord",
  "to": "1473797470361354332"
}
```

### B) Missing target (hard fail)

```json
{
  "sessionKey": "payments",
  "prompt": "This fails because `to` is missing."
}
```

Returns: `MISSING_TARGET_CHANNEL`

## Config notes

- Keep your existing `/hooks/agent` endpoint unchanged; this pack is additive.
- Ensure session routing has a default when desired (e.g. `hooks.defaultSessionKey`) if callers omit `sessionKey`.
- Prefer explicit `sessionKey` + `to` in production automations.

## Deploy (example)

Copy this directory into your OpenClaw hooks path and register it as a hook pack named `agent-delegate` per your runtime's hook-pack loader.
