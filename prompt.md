Build a single-file landing page (index.html) for ClawDaddy.com — a hosting/deployment service for OpenClaw AI assistants. Use Tailwind CSS via CDN, no build step, no frameworks. Dark theme with lobster-red (#E63946) accents. Playful but credible tone. Mobile responsive.

Design references: Clean, modern SaaS landing page. Think Linear.app meets indie hacker energy. Generous whitespace, big bold headlines, subtle animations on scroll.

Logo/Brand: "ClawDaddy" with a 🦞 emoji. Tagline: "Your AI assistant. No PhD required."

Sections in order:

1. Hero
- Headline: "Your AI assistant. Running in 10 minutes. No PhD required."
- Subheadline: "OpenClaw is incredible. Setting it up shouldn't require a weekend and a Stack Overflow addiction. Pick your plan. We handle the rest."
- CTA button: "Get Started →" (scrolls to pricing)
- Subtle animated lobster claw SVG or emoji accent

2. Social Proof Bar
- Horizontal scrolling quotes from OpenClaw users:
  - "It's running my company." — @therno
  - "The future is already here." — @jonahships_
  - "Personal AI is getting real." — @christinetyip
  - "First time I have felt like I am living in the future since the launch of ChatGPT." — @davemorin
  - "After years of AI hype, I thought nothing could faze me. Then I installed OpenClaw." — @lycfyi

3. What Is OpenClaw? (brief)
- "An open-source AI assistant that lives on a server and connects to your chat apps. Think ChatGPT, but it can actually do things — check your email, manage your calendar, write code, browse the web, and remember everything."
- Icons/badges for: Discord, Telegram, Signal, WhatsApp, iMessage
- "OpenClaw is free and open source. We just make it stupid easy to get running."

4. How It Works
Three steps with icons:
1. "Pick a plan" — DIY, hosted, or fully managed
2. "Connect your channels" — Discord, Telegram, Signal, WhatsApp — whatever you already use
3. "Talk to your assistant" — It checks your email, manages files, writes code, browses the web, and more. Average setup: 4 minutes for managed plans.

5. Pricing (three cards, center card highlighted)

Card 1 — 🔧 Self-Install — $49 one-time
- Works on Mac, Windows (WSL), Linux, or any VPS
- Polished install script + step-by-step guide
- Installs OpenClaw + everything it needs
- Connect Discord, Telegram, Signal, WhatsApp
- No terminal experience needed
- Includes troubleshooting FAQ
- You manage it, you own it
- Italic footer: "Got a spare laptop or old PC? That's all you need."
- CTA: "Buy Script — $49"

Card 2 (highlighted/featured) — 🏠 Managed BYOK — $35/mo
- "MOST POPULAR" badge
- We host it. You bring your Anthropic API key.
- Dedicated cloud instance, auto-provisioned
- OpenClaw installed and configured for you
- Connect Discord, Telegram, Signal, WhatsApp
- Daily backups, monitoring, auto-updates
- VNC access to your instance
- Ready in under 5 minutes after checkout
- CTA: "Get Started — $35/mo"

Card 3 — 👑 Fully Managed — $75/mo
- Hands-off. We handle literally everything.
- Everything in Managed, plus:
- No API key needed — we provide it
- Sonnet model included (Opus upgrade +$25/mo)
- Usage monitoring and fair-use budgeting
- Priority support
- CTA: "Get Started — $75/mo"

6. Comparison Table
Feature comparison across all three tiers:

| Feature | Self-Install | Managed BYOK | Fully Managed |
| Setup | You run the script | Automatic | Automatic |
| Hosting | Your machine | We host | We host |
| API Key | Yours | Yours | Included |
| Channels | All | All | All |
| Backups | DIY | Daily | Daily |
| Updates | Manual | Automatic | Automatic |
| Monitoring | DIY | 24/7 | 24/7 |
| Support | FAQ/Guide | Email | Priority |
| VNC Access | N/A | ✅ | ✅ |

7. FAQ (accordion style, click to expand)

Q: What is OpenClaw?
A: An open-source AI assistant that lives on a server and connects to your chat apps. It can check your email, manage your calendar, write code, browse the web, and remember everything across conversations. It's like having a really smart intern who never sleeps.

Q: What do I need to run this myself?
A: Any Mac (Intel or Apple Silicon), Windows PC (10/11 with WSL), or Linux machine. Even that old laptop collecting dust works — OpenClaw is lightweight. Leave it plugged in and connected to WiFi, and you've got a 24/7 AI assistant. A $5/mo VPS works too if you'd rather run it in the cloud.

Q: Do I need to keep my computer on?
A: Yes — your assistant lives on that machine. If it sleeps, your assistant sleeps. That's why we offer managed plans — we keep it running 24/7 so you don't have to.

Q: Why not just set it up myself for free?
A: You absolutely can! OpenClaw is open source. Our $49 script just saves you the afternoon of googling error messages. And if you'd rather skip the terminal entirely, our managed plans exist.

Q: Is my data safe?
A: Your instance is yours alone — dedicated server, not shared. We never access your data, conversations, or API keys. You get full VNC access to your machine.

Q: What if I want to leave?
A: Export your data anytime. Cancel and we keep your instance running for 7 days so you can migrate. No lock-in, no guilt trips.

Q: Can I use Opus instead of Sonnet?
A: On the Fully Managed plan, add Opus for +$25/mo. On BYOK and Self-Install, use whatever model your API key supports.

Q: What's an API key?
A: It's like a password that lets your assistant talk to the AI. You get one from Anthropic (the company behind Claude) at console.anthropic.com. Takes 2 minutes. Our Fully Managed plan skips this — we provide the AI.

8. Footer
- "Built by a guy who got tired of setting up OpenClaw for friends."
- "ClawDaddy is not affiliated with OpenClaw. OpenClaw is open source and awesome — go star it on GitHub."
- Links: GitHub, Discord community, Contact (email)
- © 2026 ClawDaddy

All CTA buttons should link to "#" as placeholder — I'll add Stripe links later.
