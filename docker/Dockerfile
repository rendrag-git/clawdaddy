###############################################################################
# ClawDaddy — OpenClaw Managed Hosting Image
# 
# Usage:
#   docker build -t clawdaddy/openclaw .
#   docker run -d \
#     -e ANTHROPIC_API_KEY=sk-ant-... \
#     -e CUSTOMER_ID=cust_123 \
#     -p 18789:18789 \
#     clawdaddy/openclaw
###############################################################################

FROM node:22-slim AS base

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # VNC & X11
    tigervnc-standalone-server \
    xterm \
    x11-xserver-utils \
    scrot \
    xdotool \
    # Chromium
    chromium \
    chromium-sandbox \
    # Utilities
    curl \
    git \
    ca-certificates \
    procps \
    dbus-x11 \
    fonts-liberation \
    fonts-noto-color-emoji \
    # Build tools for native modules (@discordjs/opus)
    python3 \
    build-essential \
    libopus-dev \
    && rm -rf /var/lib/apt/lists/*

# Install OpenClaw, Claude Code CLI, and Codex CLI globally
RUN npm install -g openclaw @anthropic-ai/claude-code @openai/codex

# Create non-root user for running OpenClaw
RUN useradd -m -s /bin/bash clawd

# Create workspace structure
RUN mkdir -p /home/clawd/clawd/{memory,skills,config,scripts} \
    && mkdir -p /home/clawd/.openclaw \
    && mkdir -p /home/clawd/.vnc

# Default workspace files
COPY files/SOUL.md /home/clawd/clawd/SOUL.md
COPY files/USER.md /home/clawd/clawd/USER.md
COPY files/AGENTS.md /home/clawd/clawd/AGENTS.md

# VNC xstartup
COPY files/xstartup /home/clawd/.vnc/xstartup
RUN chmod 755 /home/clawd/.vnc/xstartup

# Entrypoint handles config injection + service startup
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

# Fix ownership
RUN chown -R clawd:clawd /home/clawd

# Expose ports
# 18789 = OpenClaw gateway (webchat + API)
# 5901  = VNC (optional, for browser automation)
EXPOSE 18789 5901

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:18789/ || exit 1

ENTRYPOINT ["/entrypoint.sh"]
