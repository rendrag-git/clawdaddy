#!/usr/bin/env node
/**
 * IMAP/SMTP Email Plugin for OpenClaw
 * MCP Server implementing email operations via IMAP + SMTP
 * 
 * Supports Gmail (app passwords), Outlook, and standard IMAP/SMTP providers
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

// Configuration from environment variables
const CONFIG = {
  imap: {
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: parseInt(process.env.IMAP_PORT || '993'),
    secure: true,
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASS
    },
    logger: false
  },
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER || process.env.IMAP_USER,
      pass: process.env.SMTP_PASS || process.env.IMAP_PASS
    }
  },
  emailFrom: process.env.EMAIL_FROM || process.env.IMAP_USER
};

// Validate required config
if (!CONFIG.imap.auth.user || !CONFIG.imap.auth.pass) {
  console.error('ERROR: IMAP_USER and IMAP_PASS environment variables are required');
  process.exit(1);
}

// Create SMTP transport
const transporter = nodemailer.createTransport(CONFIG.smtp);

/**
 * Connect to IMAP server
 */
async function connectIMAP() {
  const client = new ImapFlow(CONFIG.imap);
  await client.connect();
  return client;
}

/**
 * Format email for display
 */
function formatEmail(msg, full = false) {
  const result = {
    uid: msg.uid,
    messageId: msg.envelope?.messageId,
    from: msg.envelope?.from?.[0]?.address || 'unknown',
    fromName: msg.envelope?.from?.[0]?.name,
    to: msg.envelope?.to?.map(t => t.address).join(', '),
    subject: msg.envelope?.subject || '(no subject)',
    date: msg.envelope?.date?.toISOString() || msg.internalDate?.toISOString(),
    flags: msg.flags || []
  };

  if (full && msg.parsed) {
    result.textBody = msg.parsed.text;
    result.htmlBody = msg.parsed.html;
    result.attachments = msg.parsed.attachments?.map(a => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size
    })) || [];
  }

  return result;
}

/**
 * Tool: check_inbox
 * List recent/unread emails from inbox
 */
async function checkInbox(args) {
  const limit = args.limit || 20;
  const unreadOnly = args.unread_only !== false; // default true

  const client = await connectIMAP();
  
  try {
    await client.mailboxOpen('INBOX');
    
    const searchCriteria = unreadOnly ? { seen: false } : { all: true };
    const messages = [];
    
    for await (const msg of client.fetch(searchCriteria, {
      envelope: true,
      flags: true,
      uid: true,
      internalDate: true
    }, { uid: true })) {
      messages.push(formatEmail(msg));
    }
    
    // Sort by date descending
    messages.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: messages.length,
          emails: messages.slice(0, limit)
        }, null, 2)
      }]
    };
  } finally {
    await client.logout();
  }
}

/**
 * Tool: read_email
 * Fetch full email content by UID or message ID
 */
async function readEmail(args) {
  const { uid, message_id } = args;
  
  if (!uid && !message_id) {
    throw new Error('Either uid or message_id is required');
  }

  const client = await connectIMAP();
  
  try {
    await client.mailboxOpen('INBOX');
    
    let searchCriteria;
    if (message_id) {
      searchCriteria = { header: ['message-id', message_id] };
    } else {
      searchCriteria = { uid: parseInt(uid) };
    }
    
    let email = null;
    
    for await (const msg of client.fetch(searchCriteria, {
      envelope: true,
      flags: true,
      uid: true,
      internalDate: true,
      source: true
    }, { uid: true })) {
      const parsed = await simpleParser(msg.source);
      email = formatEmail({ ...msg, parsed }, true);
      
      // Mark as seen
      await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
      break; // Only fetch first match
    }
    
    if (!email) {
      throw new Error('Email not found');
    }
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(email, null, 2)
      }]
    };
  } finally {
    await client.logout();
  }
}

/**
 * Tool: search_emails
 * Search emails by query
 */
async function searchEmails(args) {
  const { query, limit = 50 } = args;
  
  if (!query) {
    throw new Error('query parameter is required');
  }

  const client = await connectIMAP();
  
  try {
    await client.mailboxOpen('INBOX');
    
    // Parse query into IMAP search criteria
    // Support: from:, to:, subject:, body:, before:, since:, unread
    const criteria = {};
    
    const parts = query.match(/(\w+):(\S+)|(\S+)/g) || [];
    
    for (const part of parts) {
      if (part.includes(':')) {
        const [key, value] = part.split(':');
        switch (key.toLowerCase()) {
          case 'from':
            criteria.from = value;
            break;
          case 'to':
            criteria.to = value;
            break;
          case 'subject':
            criteria.subject = value;
            break;
          case 'body':
            criteria.body = value;
            break;
          case 'before':
            criteria.before = new Date(value);
            break;
          case 'since':
            criteria.since = new Date(value);
            break;
        }
      } else if (part === 'unread') {
        criteria.seen = false;
      } else {
        // Default: search in subject
        criteria.subject = part;
      }
    }
    
    if (Object.keys(criteria).length === 0) {
      criteria.subject = query; // Fallback to subject search
    }
    
    const messages = [];
    
    for await (const msg of client.fetch(criteria, {
      envelope: true,
      flags: true,
      uid: true,
      internalDate: true
    }, { uid: true })) {
      messages.push(formatEmail(msg));
    }
    
    messages.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query,
          count: messages.length,
          emails: messages.slice(0, limit)
        }, null, 2)
      }]
    };
  } finally {
    await client.logout();
  }
}

/**
 * Tool: send_email
 * Compose and send a new email
 */
async function sendEmail(args) {
  const { to, subject, body, html, cc, bcc } = args;
  
  if (!to || !subject || (!body && !html)) {
    throw new Error('to, subject, and body/html are required');
  }

  const mailOptions = {
    from: CONFIG.emailFrom,
    to,
    subject,
    text: body,
    html: html || undefined,
    cc: cc || undefined,
    bcc: bcc || undefined
  };

  const info = await transporter.sendMail(mailOptions);
  
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: true,
        messageId: info.messageId,
        response: info.response
      }, null, 2)
    }]
  };
}

/**
 * Tool: reply_email
 * Reply to a specific email
 */
async function replyEmail(args) {
  const { uid, message_id, body, html } = args;
  
  if (!uid && !message_id) {
    throw new Error('Either uid or message_id is required');
  }
  
  if (!body && !html) {
    throw new Error('body or html is required');
  }

  // First fetch the original email
  const client = await connectIMAP();
  
  try {
    await client.mailboxOpen('INBOX');
    
    let searchCriteria;
    if (message_id) {
      searchCriteria = { header: ['message-id', message_id] };
    } else {
      searchCriteria = { uid: parseInt(uid) };
    }
    
    let originalEmail = null;
    
    for await (const msg of client.fetch(searchCriteria, {
      envelope: true,
      source: true
    }, { uid: true })) {
      const parsed = await simpleParser(msg.source);
      originalEmail = {
        from: msg.envelope?.from?.[0]?.address,
        subject: msg.envelope?.subject,
        messageId: msg.envelope?.messageId,
        parsed
      };
      break;
    }
    
    if (!originalEmail) {
      throw new Error('Original email not found');
    }
    
    // Compose reply
    const replySubject = originalEmail.subject.startsWith('Re:') 
      ? originalEmail.subject 
      : `Re: ${originalEmail.subject}`;
    
    const mailOptions = {
      from: CONFIG.emailFrom,
      to: originalEmail.from,
      subject: replySubject,
      text: body,
      html: html || undefined,
      inReplyTo: originalEmail.messageId,
      references: originalEmail.messageId
    };

    const info = await transporter.sendMail(mailOptions);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          messageId: info.messageId,
          replyTo: originalEmail.from,
          response: info.response
        }, null, 2)
      }]
    };
  } finally {
    await client.logout();
  }
}

/**
 * Initialize MCP Server
 */
const server = new Server(
  {
    name: 'imap-email',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Register tools
server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'check_inbox',
      description: 'List recent/unread emails from inbox',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of emails to return (default: 20)',
            default: 20
          },
          unread_only: {
            type: 'boolean',
            description: 'Only show unread emails (default: true)',
            default: true
          }
        }
      }
    },
    {
      name: 'read_email',
      description: 'Fetch full email content by UID or message ID',
      inputSchema: {
        type: 'object',
        properties: {
          uid: {
            type: 'number',
            description: 'Email UID (unique identifier within mailbox)'
          },
          message_id: {
            type: 'string',
            description: 'Email Message-ID header (globally unique)'
          }
        }
      }
    },
    {
      name: 'search_emails',
      description: 'Search emails by query. Supports: from:, to:, subject:, body:, before:, since:, unread',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (e.g., "from:john subject:meeting" or "unread")',
            required: true
          },
          limit: {
            type: 'number',
            description: 'Maximum results (default: 50)',
            default: 50
          }
        },
        required: ['query']
      }
    },
    {
      name: 'send_email',
      description: 'Compose and send a new email',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient email address(es), comma-separated',
            required: true
          },
          subject: {
            type: 'string',
            description: 'Email subject',
            required: true
          },
          body: {
            type: 'string',
            description: 'Plain text email body'
          },
          html: {
            type: 'string',
            description: 'HTML email body (optional, alternative to body)'
          },
          cc: {
            type: 'string',
            description: 'CC recipients, comma-separated'
          },
          bcc: {
            type: 'string',
            description: 'BCC recipients, comma-separated'
          }
        },
        required: ['to', 'subject']
      }
    },
    {
      name: 'reply_email',
      description: 'Reply to a specific email',
      inputSchema: {
        type: 'object',
        properties: {
          uid: {
            type: 'number',
            description: 'Original email UID'
          },
          message_id: {
            type: 'string',
            description: 'Original email Message-ID'
          },
          body: {
            type: 'string',
            description: 'Reply text (plain text)'
          },
          html: {
            type: 'string',
            description: 'Reply HTML (optional, alternative to body)'
          }
        },
        required: ['body']
      }
    }
  ]
}));

// Handle tool calls
server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'check_inbox':
        return await checkInbox(args || {});
      case 'read_email':
        return await readEmail(args || {});
      case 'search_emails':
        return await searchEmails(args || {});
      case 'send_email':
        return await sendEmail(args || {});
      case 'reply_email':
        return await replyEmail(args || {});
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error: ${error.message}`
      }],
      isError: true
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('IMAP/SMTP Email MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
