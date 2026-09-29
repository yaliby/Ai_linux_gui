#!/usr/bin/env bash
# מפעיל את ממשק RTL ל-Claude Code ופותח אותו כחלון אפליקציה עצמאי (app mode).
# מרים את השרת רק אם הוא לא כבר רץ על הפורט.
#
# קיבוץ לשורת המשימות (KDE/Plasma + Brave Flatpak):
# ב-Wayland Flatpak נועל את app_id לשם הדפדפן → החלון נדבק לאייקון Brave.
# לכן: (1) פרופיל נפרד + --app (2) ניסיון X11 עם XAUTHORITY, ואם נכשל — Wayland
# (3) כלל KWin שמכריח desktopfile=rtl-claude לפי כותרת "ממשק עברית".
set -u
DIR="/home/yali/Downloads/Progects/rtl-claude"
PORT="${PORT:-4173}"
URL="http://localhost:${PORT}"
APP_CLASS="rtl-claude"
LOG="/tmp/rtl-claude-launch.log"
RULE_ID="a7c3e91b-rtl1-4c0d-9e2a-claude0rtl001"
cd "$DIR" || exit 1
: >"$LOG"

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null && exec 3>&- 2>/dev/null; }

server_healthy() {
  if command -v curl >/dev/null 2>&1; then
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${URL}/")" = "200" ]
  else
    port_up
  fi
}

server_pid() { ss -ltnHp "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1; }

# קבצי ה-static נטענים טריים בכל רענון, אבל server.js נקרא רק פעם אחת בעליית התהליך.
# שרת שעלה לפני עריכת הקוד עונה 200 ונראה "בריא", בעוד ה-UI כבר קורא לנתיבים
# שהוא לא מכיר (למשל /api/store → 404, ואז חיווי "לא נשמר").
server_stale() {
  local pid started src
  pid="$(server_pid)" || return 1
  [ -n "${pid:-}" ] || return 1
  started="$(date -d "$(ps -o lstart= -p "$pid" 2>/dev/null)" +%s 2>/dev/null)" || return 1
  [ -n "${started:-}" ] || return 1
  src="$(stat -c %Y "$DIR/server.js" 2>/dev/null)" || return 1
  [ -n "${src:-}" ] || return 1
  [ "$src" -gt "$started" ]
}

stop_server() {
  local pid
  pid="$(server_pid)"
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
  for _ in $(seq 1 20); do port_up || return 0; sleep 0.25; done
  [ -n "${pid:-}" ] && kill -9 "$pid" 2>/dev/null
  return 0
}

start_server() {
  # setsid — בלעדיו השרת יורש את קבוצת התהליכים של המפעיל ונהרג יחד איתה
  # (למשל כשמריצים את הסקריפט מטרמינל שנסגר).
  if command -v setsid >/dev/null 2>&1; then
    setsid npm start >/tmp/rtl-claude.log 2>&1 </dev/null &
  else
    nohup npm start >/tmp/rtl-claude.log 2>&1 </dev/null &
  fi
  disown 2>/dev/null || true
  for _ in $(seq 1 40); do
    server_healthy && return 0
    sleep 0.25
  done
  return 1
}

# כלל KWin: משייך חלונות עם הכותרת שלנו לקובץ rtl-claude.desktop (אייקון בשורת המשימות)
ensure_kwin_rule() {
  local conf="${XDG_CONFIG_HOME:-$HOME/.config}/kwinrulesrc"
  mkdir -p "$(dirname "$conf")"
  if [ -f "$conf" ] && grep -q "$RULE_ID" "$conf" 2>/dev/null; then
    return 0
  fi
  if [ ! -f "$conf" ]; then
    cat >"$conf" <<EOF
[General]
count=1
rules=$RULE_ID

[$RULE_ID]
Description=RTL Claude taskbar grouping
desktopfile=rtl-claude
desktopfilerule=2
title=ממשק עברית
titlematch=2
types=1
EOF
  else
    # מוסיפים את הכלל לקובץ קיים בלי לדרוס כללים אחרים
    local count rules
    count=$(grep -E '^count=' "$conf" | head -1 | cut -d= -f2)
    rules=$(grep -E '^rules=' "$conf" | head -1 | cut -d= -f2)
    count=${count:-0}
    count=$((count + 1))
    if [ -n "${rules:-}" ]; then
      rules="$rules,$RULE_ID"
    else
      rules="$RULE_ID"
    fi
    if grep -q '^\[General\]' "$conf"; then
      sed -i \
        -e "s/^count=.*/count=$count/" \
        -e "s/^rules=.*/rules=$rules/" \
        "$conf"
    else
      printf '%s\n' '[General]' "count=$count" "rules=$rules" '' | cat - "$conf" >"$conf.tmp" && mv "$conf.tmp" "$conf"
    fi
    cat >>"$conf" <<EOF

[$RULE_ID]
Description=RTL Claude taskbar grouping
desktopfile=rtl-claude
desktopfilerule=2
title=ממשק עברית
titlematch=2
types=1
EOF
  fi
  # טעינת הכללים מחדש ב-Plasma
  if command -v dbus-send >/dev/null 2>&1; then
    dbus-send --session --type=method_call --dest=org.kde.KWin /KWin org.kde.KWin.reconfigure >/dev/null 2>&1 || true
  fi
}

if server_healthy && server_stale; then
  echo "launch: השרת עלה לפני עדכון server.js — מפעיל מחדש" >>"$LOG"
  stop_server
fi

if ! server_healthy; then
  port_up && stop_server
  start_server || echo "launch: השרת לא עלה — ראו /tmp/rtl-claude.log" >>"$LOG"
fi

ensure_kwin_rule

PROFILE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/rtl-claude/chromium-profile"
mkdir -p "$PROFILE_DIR"

if pgrep -f "user-data-dir=${PROFILE_DIR}" >/dev/null 2>&1; then
  echo "launch: already running, focusing" >>"$LOG"
  if command -v wmctrl >/dev/null 2>&1; then
    wmctrl -x -a "$APP_CLASS" 2>/dev/null || wmctrl -a "ממשק עברית" 2>/dev/null || wmctrl -a "Claude" 2>/dev/null || true
  fi
  exit 0
fi

CHROME_APP_FLAGS=(
  --user-data-dir="$PROFILE_DIR"
  --app="$URL"
  --class="$APP_CLASS"
  --name="$APP_CLASS"
  --no-first-run
  --no-default-browser-check
  --disable-extensions
)

# דגלי X11 — רק כשיש DISPLAY + XAUTHORITY תקינים (אחרת Chromium נכשל מיד)
CHROME_X11_FLAGS=(
  --ozone-platform=x11
  --ozone-platform-hint=x11
)

x11_ready() {
  [ -n "${DISPLAY:-}" ] && [ -n "${XAUTHORITY:-}" ] && [ -r "$XAUTHORITY" ]
}

browser_still_up() {
  local pid="$1"
  sleep 1.2
  kill -0 "$pid" 2>/dev/null
}

open_native() {
  local b="$1"
  local pid
  if x11_ready; then
    echo "launch: native $b --app (x11)" >>"$LOG"
    env -u WAYLAND_DISPLAY \
      DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY" \
      "$b" "${CHROME_APP_FLAGS[@]}" "${CHROME_X11_FLAGS[@]}" >>"$LOG" 2>&1 &
    pid=$!
    if browser_still_up "$pid"; then return 0; fi
    echo "launch: native x11 failed, trying wayland/default" >>"$LOG"
  fi
  echo "launch: native $b --app" >>"$LOG"
  "$b" "${CHROME_APP_FLAGS[@]}" >>"$LOG" 2>&1 &
  pid=$!
  browser_still_up "$pid"
}

open_flatpak() {
  local id="$1"
  local pid
  local fp_base=(
    run
    --filesystem="${PROFILE_DIR}:create"
  )
  # גישה לקובץ ה-X auth (בדרך כלל תחת /run/user/UID/)
  if [ -n "${XAUTHORITY:-}" ] && [ -r "$XAUTHORITY" ]; then
    fp_base+=(--filesystem="$(dirname "$XAUTHORITY"):ro" --env=XAUTHORITY="$XAUTHORITY")
  fi

  if x11_ready; then
    echo "launch: flatpak $id --app (x11 + kwin rule)" >>"$LOG"
    flatpak "${fp_base[@]}" \
      --nosocket=wayland \
      --socket=fallback-x11 \
      --socket=x11 \
      --unset-env=WAYLAND_DISPLAY \
      --env=DISPLAY="$DISPLAY" \
      "$id" \
      "${CHROME_APP_FLAGS[@]}" "${CHROME_X11_FLAGS[@]}" >>"$LOG" 2>&1 &
    pid=$!
    if browser_still_up "$pid"; then return 0; fi
    echo "launch: flatpak x11 failed, falling back to wayland/session default" >>"$LOG"
    pkill -f "user-data-dir=${PROFILE_DIR}" 2>/dev/null || true
    sleep 0.3
  fi

  # Wayland / ברירת המחדל של ה-Flatpak — עובד ב-Plasma Wayland; קיבוץ אייקון דרך כלל KWin לפי כותרת
  echo "launch: flatpak $id --app (session default)" >>"$LOG"
  flatpak "${fp_base[@]}" \
    "$id" \
    "${CHROME_APP_FLAGS[@]}" >>"$LOG" 2>&1 &
  pid=$!
  browser_still_up "$pid"
}

open_app() {
  for b in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge microsoft-edge-stable vivaldi-stable; do
    if command -v "$b" >/dev/null 2>&1; then
      open_native "$b" && return 0
    fi
  done

  if command -v flatpak >/dev/null 2>&1; then
    for id in com.brave.Browser com.google.Chrome org.chromium.Chromium com.microsoft.Edge com.vivaldi.Vivaldi; do
      if flatpak info "$id" >/dev/null 2>&1; then
        open_flatpak "$id" && return 0
      fi
    done
  fi

  echo "launch: no chromium app-mode browser found" >>"$LOG"
  return 1
}

if ! open_app; then
  echo "launch: fallback xdg-open (no app-mode browser)" >>"$LOG"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 &
  else
    echo "פתחו בדפדפן: $URL"
  fi
fi
