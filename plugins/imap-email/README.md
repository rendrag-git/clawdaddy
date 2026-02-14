# IMAP/SMTP Email Plugin for OpenClaw

MCP server providing email operations via IMAP (reading) and SMTP (sending). Works natively with OpenClaw's MCP integration.

## Features

- ✅ **check_inbox** — List recent/unread emails
- ✅ **read_email** — Fetch full email content by UID or Message-ID
- ✅ **search_emails** — Search with flexible queries (from:, to:, subject:, etc.)
- ✅ **send_email** — Compose and send new emails
- ✅ **reply_email** — Reply to specific emails with proper threading

## Installation

```bash
cd ~/clawd/clawdaddy/plugins/imap-email
npm install
chmod +x index.js
```

## Configuration

Set environment variables for your email provider:

### Required Variables

```bash
# IMAP (reading emails)
export IMAP_HOST="imap.gmail.com"
export IMAP_PORT="993"
export IMAP_USER="your-email@gmail.com"
export IMAP_PASS="your-app-password"

# SMTP (sending emails)
export SMTP_HOST="smtp.gmail.com"
export SMTP_PORT="587"
export SMTP_USER="your-email@gmail.com"  # defaults to IMAP_USER if not set
export SMTP_PASS="your-app-password"     # defaults to IMAP_PASS if not set

# Sender address
export EMAIL_FROM="your-email@gmail.com"  # defaults to IMAP_USER if not set
```

### Provider-Specific Settings

#### Gmail (Recommended: App Passwords)

**Setup:**
1. Enable 2FA on your Google account
2. Generate app password: https://myaccount.google.com/apppasswords
3. Use app password for both IMAP_PASS and SMTP_PASS

```bash
export IMAP_HOST="imap.gmail.com"
export IMAP_PORT="993"
export SMTP_HOST="smtp.gmail.com"
export SMTP_PORT="587"
export IMAP_USER="you@gmail.com"
export IMAP_PASS="xxxx xxxx xxxx xxxx"  # 16-char app password
export EMAIL_FROM="you@gmail.com"
```

#### Outlook / Office 365

```bash
export IMAP_HOST="outlook.office365.com"
export IMAP_PORT="993"
export SMTP_HOST="smtp.office365.com"
export SMTP_PORT="587"
export IMAP_USER="you@outlook.com"
export IMAP_PASS="your-password"
export EMAIL_FROM="you@outlook.com"
```

#### ProtonMail (via Bridge)

```bash
export IMAP_HOST="127.0.0.1"
export IMAP_PORT="1143"
export SMTP_HOST="127.0.0.1"
export SMTP_PORT="1025"
export IMAP_USER="you@protonmail.com"
export IMAP_PASS="protonmail-bridge-password"
export EMAIL_FROM="you@protonmail.com"
```

#### Generic IMAP/SMTP Provider

```bash
export IMAP_HOST="mail.yourprovider.com"
export IMAP_PORT="993"
export SMTP_HOST="mail.yourprovider.com"
export SMTP_PORT="587"
export IMAP_USER="you@yourprovider.com"
export IMAP_PASS="your-password"
export EMAIL_FROM="you@yourprovider.com"
```

## OpenClaw Integration

Add to your OpenClaw MCP config (`~/.openclaw/mcp.json` or `~/.openclaw/agents/main/mcp.json`):

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["/home/clawd/clawdaddy/plugins/imap-email/index.js"],
      "env": {
        "IMAP_HOST": "imap.gmail.com",
        "IMAP_PORT": "993",
        "IMAP_USER": "your-email@gmail.com",
        "IMAP_PASS": "your-app-password",
        "SMTP_HOST": "smtp.gmail.com",
        "SMTP_PORT": "587",
        "EMAIL_FROM": "your-email@gmail.com"
      }
    }
  }
}
```

Restart OpenClaw gateway:

```bash
openclaw gateway restart
```

## Usage Examples

Once configured, use email tools through OpenClaw:

### Check Inbox

```javascript
// List 10 most recent unread emails
check_inbox({ limit: 10, unread_only: true })

// List all recent emails
check_inbox({ limit: 20, unread_only: false })
```

### Read Email

```javascript
// By UID (from check_inbox results)
read_email({ uid: 12345 })

// By Message-ID
read_email({ message_id: "<unique-id@gmail.com>" })
```

### Search Emails

```javascript
// Search by sender
search_emails({ query: "from:john@example.com" })

// Search by subject
search_emails({ query: "subject:meeting" })

// Multiple criteria
search_emails({ query: "from:boss subject:urgent unread" })

// Date range
search_emails({ query: "since:2024-01-01 before:2024-02-01" })
```

### Send Email

```javascript
send_email({
  to: "recipient@example.com",
  subject: "Hello from OpenClaw",
  body: "This is a test email sent via IMAP/SMTP plugin."
})

// With CC/BCC
send_email({
  to: "main@example.com",
  cc: "copy@example.com",
  bcc: "secret@example.com",
  subject: "Group Update",
  body: "Here's the weekly summary..."
})

// HTML email
send_email({
  to: "recipient@example.com",
  subject: "Rich Email",
  html: "<h1>Hello!</h1><p>This is <strong>HTML</strong> email.</p>"
})
```

### Reply to Email

```javascript
// Reply by UID
reply_email({
  uid: 12345,
  body: "Thanks for reaching out! I'll look into this."
})

// Reply by Message-ID
reply_email({
  message_id: "<original@gmail.com>",
  body: "Here's the information you requested..."
})
```

## Testing

Create a `.env` file with your credentials:

```bash
# .env
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=test@gmail.com
IMAP_PASS=xxxx-xxxx-xxxx-xxxx
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
EMAIL_FROM=test@gmail.com
```

Run standalone test:

```bash
# Load env vars and run
source .env && node index.js
```

The server will listen on stdio for MCP protocol messages.

## Troubleshooting

### Gmail Authentication Errors

- **Error: Invalid credentials**
  - Make sure you're using an app password, not your regular password
  - 2FA must be enabled for app passwords
  - Regenerate app password if needed

### Connection Timeouts

- Check firewall/network allows IMAP (993) and SMTP (587) ports
- For corporate networks, you may need to whitelist Gmail/Outlook servers

### "Mailbox does not exist" Errors

- Some providers use different folder names (e.g., "Inbox" vs "INBOX")
- Plugin uses "INBOX" by default (standard for most providers)

### SSL/TLS Errors

- Plugin uses secure connections by default (IMAPS on 993, STARTTLS on 587)
- If your provider uses non-standard ports, adjust IMAP_PORT/SMTP_PORT

## Security Notes

- **Never commit credentials** to git repositories
- Use app-specific passwords when available (Gmail, Outlook)
- Store credentials in environment variables or secure vaults
- Consider using OpenClaw's encrypted credential storage

## License

MIT
