#!/usr/bin/env bash
#
# Build the plugin and install it on a local Homebridge instance (hb-service layout).
#
# Usage:
#   HB_HOST=<host or ssh alias> [HB_USER=<user>] [HB_PREFIX=/var/lib/homebridge] \
#     [HB_RESTART=child|all|none] scripts/deploy-local.sh
#
# HB_USER defaults to the user of the ssh config (or the local user). HB_RESTART=child (default)
# restarts only the child bridge running this plugin; use "all" if the plugin runs on the main bridge.
#
# Use a pre-release version (e.g. `npm version 0.1.0-matter.1 --no-git-tag-version`) before
# deploying, otherwise the Homebridge UI may offer to "update" to the npm release.
# Roll back with `npm install homebridge-wled-ws@<version>` in HB_PREFIX on the host.
# See docs/MATTER_PLAN.md, section "Local test deployment".

set -euo pipefail

: "${HB_HOST:?set HB_HOST to the Homebridge host, IP or ssh alias}"
HB_PREFIX="${HB_PREFIX:-/var/lib/homebridge}"
HB_RESTART="${HB_RESTART:-child}"
TARGET="${HB_USER:+$HB_USER@}$HB_HOST"

case "$HB_RESTART" in
  child | all | none) ;;
  *) echo "HB_RESTART must be child, all or none" >&2; exit 1 ;;
esac

cd "$(dirname "$0")/.."

PLUGIN=$(node -p "require('./package.json').name")

# npm pack runs the prepare script, which builds dist/
TGZ=$(npm pack --silent | tail -n 1)
trap 'rm -f "$TGZ"' EXIT
echo "Packed $TGZ"

scp "$TGZ" "$TARGET:/tmp/$TGZ"

# - npm records the tarball path in HB_PREFIX/package.json, so the tarball is kept in
#   HB_PREFIX/local-plugins; otherwise later plugin installs from the UI fail.
# - hb-service installs bundle their own node in /opt/homebridge/bin, which is usually not on the PATH.
# - install as the homebridge user: via runuser when logged in as root, otherwise via sudo.
# - a child bridge shuts down cleanly on SIGTERM and Homebridge starts it again.
ssh "$TARGET" "set -e
  export PATH=/opt/homebridge/bin:\$PATH
  if [ \"\$(id -u)\" = 0 ]; then AS_HB='runuser -u homebridge --'; ROOT=''; else AS_HB='sudo -u homebridge'; ROOT='sudo'; fi
  \$ROOT install -d -o homebridge -g homebridge '$HB_PREFIX/local-plugins'
  \$ROOT install -m 644 -o homebridge -g homebridge '/tmp/$TGZ' '$HB_PREFIX/local-plugins/$TGZ'
  rm -f '/tmp/$TGZ'
  cd '$HB_PREFIX'
  \$AS_HB env PATH=\"\$PATH\" npm install --no-audit --no-fund './local-plugins/$TGZ'
  find local-plugins -name '$PLUGIN-*.tgz' ! -name '$TGZ' -exec \$ROOT rm -f {} +
  case '$HB_RESTART' in
    all) \$ROOT hb-service restart ;;
    child)
      OLD=\$(pgrep -x -f 'homebridge: $PLUGIN' || true)
      if [ -z \"\$OLD\" ]; then echo 'No child bridge process for $PLUGIN found, use HB_RESTART=all' >&2; exit 1; fi
      \$ROOT kill -TERM \$OLD
      for i in \$(seq 1 60); do
        NEW=\$(pgrep -x -f 'homebridge: $PLUGIN' || true)
        if [ -n \"\$NEW\" ] && [ \"\$NEW\" != \"\$OLD\" ]; then echo \"Child bridge restarted (pid \$NEW)\"; exit 0; fi
        sleep 1
      done
      echo 'Child bridge did not come back within 60 s, check the Homebridge log' >&2; exit 1 ;;
    none) echo 'Not restarted' ;;
  esac"

echo "Deployed $TGZ to $HB_HOST"
