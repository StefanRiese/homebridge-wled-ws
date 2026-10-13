#!/usr/bin/env bash
#
# Build the plugin and install it on a local Homebridge instance (hb-service layout).
#
# Usage:
#   HB_HOST=<host> [HB_USER=<user>] [HB_PREFIX=/var/lib/homebridge] scripts/deploy-local.sh
#
# Use a pre-release version (e.g. `npm version 0.1.0-matter.1 --no-git-tag-version`) before
# deploying, otherwise the Homebridge UI may offer to "update" to the npm release.
# See docs/MATTER_PLAN.md, section "Local test deployment".

set -euo pipefail

: "${HB_HOST:?set HB_HOST to the Homebridge host or IP}"
HB_USER="${HB_USER:-root}"
HB_PREFIX="${HB_PREFIX:-/var/lib/homebridge}"
TARGET="$HB_USER@$HB_HOST"

cd "$(dirname "$0")/.."

# npm pack runs the prepare script, which builds dist/
TGZ=$(npm pack --silent | tail -n 1)
trap 'rm -f "$TGZ"' EXIT
echo "Packed $TGZ"

scp "$TGZ" "$TARGET:/tmp/$TGZ"

# install as the homebridge user: via runuser when logged in as root, otherwise via sudo
if [ "$HB_USER" = "root" ]; then
  AS_HB="runuser -u homebridge --"
  ROOT=""
else
  AS_HB="sudo -u homebridge"
  ROOT="sudo"
fi

# hb-service installs bundle their own node in /opt/homebridge/bin, which is usually not on the PATH
ssh -t "$TARGET" "set -e
  NPM=\$(command -v /opt/homebridge/bin/npm || command -v npm)
  chmod 644 '/tmp/$TGZ'
  $AS_HB \"\$NPM\" install --no-audit --no-fund --prefix '$HB_PREFIX' '/tmp/$TGZ'
  rm -f '/tmp/$TGZ'
  $ROOT hb-service restart"

echo "Deployed $TGZ to $HB_HOST"
