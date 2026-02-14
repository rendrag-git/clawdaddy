# Quick Start Guide

## 1. Gmail Setup (Recommended)

### Get App Password
1. Go to https://myaccount.google.com/apppasswords
2. Enable 2FA if not already enabled
3. Generate new app password (select "Mail" and your device)
4. Copy the 16-character password

### Configure for OpenClaw

Add to `~/.openclaw/mcp.json` or `~/.openclaw/agents/main/mcp.json`:

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["/home/clawd/clawdaddy/plugins/imap-email/index.js"],
      "env": {
        "IMAP_HOST": "imap.gmail.com",
        "IMAP_PORT": "993",
        "IMAP_USER": "you@gmail.com",
        "IMAP_PASS": "xxxx xxxx xxxx xxxx",
        "SMTP_HOST": "smtp.gmail.com",
        "SMTP_PORT": "587",
        "EMAIL_FROM": "you@gmail.com"
      }
    }
  }
}
```

Restart OpenClaw:
```bash
openclaw gateway restart
```

## 2. Test It

Ask your agent:
- "Check my inbox"
- "Search for emails from john@example.com"
- "Read email UID 12345"
- "Send email to test@example.com with subject 'Hello' and body 'Test message'"

## 3. Available Tools

- **check_inbox** — List recent/unread emails
- **read_email** — Get full email by UID or Message-ID
- **search_emails** — Search with queries like "from:john subject:meeting"
- **send_email** — Send new emails
- **reply_email** — Reply to specific emails

## Troubleshooting

### "Invalid credentials" error
- Make sure you're using app password, not your regular password
- Regenerate app password if needed

### "Connection refused"
- Check firewall allows ports 993 (IMAP) and 587 (SMTP)
- Verify IMAP is enabled in Gmail settings

### Tools not showing up
- Check `openclaw gateway` logs for MCP server errors
- Verify paths in mcp.json are correct
- Restart gateway after config changes

## Security

- Never commit mcp.json with real credentials
- Use app passwords when available
- Consider environment variables or OpenClaw's credential vault
