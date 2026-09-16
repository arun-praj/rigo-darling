#!/bin/sh
set -eu

display="${DISPLAY:-:99}"
vnc_password="${RIGOHR_VNC_PASSWORD:-}"
vnc_password_file="/app/data/vnc.pass"

if [ -z "$vnc_password" ]; then
  echo "RIGOHR_VNC_PASSWORD must be set for Docker headful mode." >&2
  exit 1
fi

# The legacy VNC password format uses the first eight characters. Reject a
# shorter value so the browser desktop cannot accidentally be left weakly
# protected by a typo or empty password.
if [ "$(printf '%s' "$vnc_password" | wc -c)" -lt 8 ]; then
  echo "RIGOHR_VNC_PASSWORD must contain at least 8 characters." >&2
  exit 1
fi

mkdir -p /app/data
rm -f /app/.browser-profile/SingletonLock \
  /app/.browser-profile/SingletonSocket \
  /app/.browser-profile/SingletonCookie
x11vnc -storepasswd "$vnc_password" "$vnc_password_file" >/dev/null
chmod 600 "$vnc_password_file"

Xvfb "$display" -screen 0 1440x1000x24 -ac -nolisten tcp >/app/data/xvfb.log 2>&1 &
xvfb_pid=$!

cleanup() {
  kill "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 1

x11vnc \
  -display "$display" \
  -rfbport 5900 \
  -rfbauth "$vnc_password_file" \
  -localhost \
  -forever \
  -shared \
  -noxdamage \
  >/app/data/x11vnc.log 2>&1 &

if command -v novnc_proxy >/dev/null 2>&1; then
  novnc_proxy --vnc 127.0.0.1:5900 --listen 6080 >/app/data/novnc.log 2>&1 &
elif [ -x /usr/share/novnc/utils/novnc_proxy ]; then
  /usr/share/novnc/utils/novnc_proxy --vnc 127.0.0.1:5900 --listen 6080 >/app/data/novnc.log 2>&1 &
else
  echo "noVNC proxy was not installed in the Docker image." >&2
  exit 1
fi

exec node /app/dist/server.js
