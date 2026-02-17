#!/bin/bash
# Voice Calibration Cron Job
# Runs 7 days after provisioning to refine personality based on actual usage patterns.
# Executes an isolated agent turn inside the OpenClaw container.

set -e

CONTAINER="openclaw"
MODEL="anthropic/claude-sonnet-4-20250514"
WORKSPACE="/home/clawd/clawd"

# Check if container is running
if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
    echo "OpenClaw container not running. Skipping calibration."
    exit 0
fi

# Build the calibration prompt
read -r -d '' CALIBRATION_PROMPT <<'CALPROMPT' || true
You are running a scheduled voice calibration check. Your job:

1. Read the conversation history in this workspace (check memory/ and sessions/ directories)
2. Analyze communication patterns:
   - Average message length (does the user write long or short messages?)
   - Tone patterns (formal/casual, frustrated/relaxed, urgent/leisurely)
   - Topics discussed most frequently
   - Time-of-day patterns (when is the user most active?)
   - Response preferences (do they prefer bullets? paragraphs? code?)
   - Challenge acceptance (do they push back on your suggestions, or accept them?)

3. Compare patterns against current SOUL.md and USER.md settings
4. Generate updated sections for SOUL.md and USER.md if calibration is needed
5. Write the updates directly to the files
6. Send a message to the user summarizing what you learned and what you adjusted

Format your user-facing message like:
"Hey — I just ran my weekly voice calibration. Here is what I noticed about our conversations so far: [findings]. Based on this, I have tweaked: [changes]. Let me know if any of this feels off."

If there is not enough conversation history yet (fewer than 10 exchanges), note this and skip the calibration. Just let the user know you will check again next week.

IMPORTANT: Be honest about what you observed. Do not make up patterns. If the data is ambiguous, say so.
CALPROMPT

# Execute the calibration as an isolated agent turn
docker exec "$CONTAINER" su - clawd -c "cd $WORKSPACE && openclaw run \
  --model $MODEL \
  --message \"$CALIBRATION_PROMPT\" \
  --max-turns 1 \
  --agent main" 2>&1 | tee /var/log/openclaw-voice-calibration.log

echo "Voice calibration completed at $(date)"
