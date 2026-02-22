#!/usr/bin/env bash
###############################################################################
# update.sh — Update OpenClaw Docker image on a customer instance
#
# Runs on the customer instance (not control plane).
# Preserves env vars, volumes, and port mappings.
#
# Usage: sudo bash update.sh
###############################################################################
set -euo pipefail

CONTAINER_NAME="openclaw"
ECR_IMAGE="public.ecr.aws/b0x3t9x7/clawdaddy/openclaw:latest"

echo "=== OpenClaw Docker Update ==="
echo "Started at $(date -Iseconds)"

# Step 1: Save current container env vars
echo "Saving current environment..."
SAVED_ENV=$(docker inspect ${CONTAINER_NAME} --format '{{json .Config.Env}}')
if [[ -z "${SAVED_ENV}" || "${SAVED_ENV}" == "null" ]]; then
    echo "ERROR: Could not read env vars from running container"
    exit 1
fi

# Step 2: Pull new image
echo "Pulling new image: ${ECR_IMAGE}..."
docker pull ${ECR_IMAGE}
docker tag ${ECR_IMAGE} clawdaddy/openclaw:latest
echo "Image pulled successfully"

# Step 3: Stop and remove old container
echo "Stopping old container..."
docker stop ${CONTAINER_NAME}
docker rm ${CONTAINER_NAME}

# Step 4: Reconstruct docker run command from saved state
echo "Starting new container with preserved config..."

# Parse env vars into array
mapfile -t RAW_ENV < <(
  echo "${SAVED_ENV}" | node -e "
    const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const skip = new Set(['PATH', 'HOME', 'HOSTNAME']);
    data.filter(e => !skip.has(e.split('=')[0])).forEach(e => process.stdout.write(e + '\n'));
  "
)

# Reconstruct docker run command safely (no eval)
DOCKER_CMD=(docker run -d --name "${CONTAINER_NAME}" --restart unless-stopped
    -p 18789:18789 -p 5901:5901
    -v openclaw-data:/home/clawd/.openclaw
    -v /home/ubuntu/clawd:/home/clawd/clawd)
for kv in "${RAW_ENV[@]}"; do
    DOCKER_CMD+=(-e "${kv}")
done
DOCKER_CMD+=(clawdaddy/openclaw:latest)
"${DOCKER_CMD[@]}"

echo "New container started"

# Step 5: Wait for health check
echo "Waiting for container to be healthy..."
for i in $(seq 1 30); do
    STATUS=$(docker inspect ${CONTAINER_NAME} --format '{{.State.Status}}' 2>/dev/null || echo "unknown")
    if [[ "${STATUS}" == "running" ]]; then
        echo "Container is running (attempt $i)"
        break
    fi
    echo "Waiting... (attempt $i/30, status: ${STATUS})"
    sleep 2
done

# Final check
FINAL_STATUS=$(docker inspect ${CONTAINER_NAME} --format '{{.State.Status}}' 2>/dev/null || echo "unknown")
if [[ "${FINAL_STATUS}" == "running" ]]; then
    echo "=== Update complete! Container running ==="
else
    echo "WARNING: Container status is '${FINAL_STATUS}' — check logs with: docker logs ${CONTAINER_NAME}"
    exit 1
fi
