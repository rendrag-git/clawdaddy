#!/usr/bin/env bash
###############################################################################
# bundle-portal.sh - Build and upload the portal S3 bundle
#
# Creates portal-v1.tar.gz containing:
#   server.js, package.json, package-lock.json, public/
#
# Does NOT include node_modules/ — npm install runs on each instance.
#
# Usage:
#   bash script/bundle-portal.sh              # build only
#   bash script/bundle-portal.sh --upload     # build + upload to S3
#
# Environment:
#   S3_BUCKET   S3 bucket name (default: clawdaddy-releases)
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORTAL_DIR="${REPO_ROOT}/portal"
BUNDLE_NAME="portal-v1.tar.gz"
OUTPUT="${REPO_ROOT}/${BUNDLE_NAME}"
S3_BUCKET="${S3_BUCKET:-clawdaddy-releases}"

UPLOAD=false
if [[ "${1:-}" == "--upload" ]]; then
    UPLOAD=true
fi

echo "Building portal bundle..."

if [[ ! -f "${PORTAL_DIR}/server.js" ]]; then
    echo "Error: portal/server.js not found" >&2
    exit 1
fi

tar -czf "${OUTPUT}" \
    --owner=0 --group=0 \
    -C "${REPO_ROOT}" \
    portal/server.js \
    portal/package.json \
    portal/package-lock.json \
    portal/public/

echo "Bundle created: ${OUTPUT} ($(wc -c < "${OUTPUT}") bytes)"

if [[ "${UPLOAD}" == "true" ]]; then
    echo "Uploading to s3://${S3_BUCKET}/${BUNDLE_NAME}..."
    aws s3 cp "${OUTPUT}" "s3://${S3_BUCKET}/${BUNDLE_NAME}" --acl public-read
    echo "Upload complete: https://${S3_BUCKET}.s3.amazonaws.com/${BUNDLE_NAME}"
fi
