#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const path = require('path');

const app = express();
const PORT = 3847;

// Rate limiting: IP -> [timestamps]
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour in ms
const RATE_LIMIT_MAX = 3;

// CORS configuration
const corsOptions = {
  origin: ['https://clawdaddy.sh', 'https://getclawdaddy.com'],
  methods: ['POST'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

// Basic email validation regex
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Rate limiting check
function checkRateLimit(ip) {
  const now = Date.now();
  
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }
  
  const timestamps = rateLimitMap.get(ip);
  
  // Remove timestamps older than 1 hour
  const recentTimestamps = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
  rateLimitMap.set(ip, recentTimestamps);
  
  if (recentTimestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }
  
  // Add current timestamp
  recentTimestamps.push(now);
  return true;
}

// Split name into first and last
function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : 'Waitlist';
  return { firstName, lastName };
}

app.post('/api/waitlist', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const timestamp = new Date().toISOString();
  
  console.log(`[${timestamp}] Waitlist submission from ${ip}`);
  
  try {
    // Validation
    const { name, email } = req.body;
    
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      console.log(`[${timestamp}] Validation failed: invalid name`);
      return res.status(400).json({ ok: false, error: 'Name is required' });
    }
    
    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
      console.log(`[${timestamp}] Validation failed: invalid email`);
      return res.status(400).json({ ok: false, error: 'Valid email is required' });
    }
    
    // Rate limiting
    if (!checkRateLimit(ip)) {
      console.log(`[${timestamp}] Rate limit exceeded for ${ip}`);
      return res.status(429).json({ ok: false, error: 'Too many submissions. Please try again later.' });
    }
    
    // Split name
    const { firstName, lastName } = splitName(name);
    
    console.log(`[${timestamp}] Creating lead: ${firstName} ${lastName} <${email}>`);
    
    // Create Zoho CRM lead via mcporter
    const bodyData = {
      data: [{
        First_Name: firstName,
        Last_Name: lastName,
        Email: email,
        Lead_Source: 'Advertisement',
        Company: 'ClawDaddy Waitlist',
        Business_Unit: 'ClawDaddy'
      }]
    };
    
    const pathVars = {
      module: 'Leads'
    };
    
    // Build mcporter command with proper JSON escaping
    const cmd = `npx mcporter call zoho ZohoCRM_Create_Records body=${JSON.stringify(JSON.stringify(bodyData))} path_variables=${JSON.stringify(JSON.stringify(pathVars))}`;
    
    console.log(`[${timestamp}] Executing: ${cmd}`);
    
    // Execute mcporter from the workspace directory
    const result = execSync(cmd, {
      cwd: '/home/ubuntu/clawd',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    console.log(`[${timestamp}] mcporter result:`, result);
    console.log(`[${timestamp}] Lead created successfully`);
    
    return res.json({ ok: true, message: "You're on the list!" });
    
  } catch (error) {
    console.error(`[${timestamp}] Error:`, error.message);
    console.error(`[${timestamp}] Stack:`, error.stack);
    return res.status(500).json({ ok: false, error: 'Failed to process submission. Please try again.' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`ClawDaddy waitlist API listening on port ${PORT}`);
  console.log(`Working directory: ${process.cwd()}`);
});
