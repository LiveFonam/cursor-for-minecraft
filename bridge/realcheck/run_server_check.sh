#!/bin/bash
# Runs the real side of the comparison on a private local Paper server, then stops that server by its saved PID.
#
#   RC_SOURCE=<folder with server/ and jdk/> RC_MODULES=<node_modules folder> bash run_server_check.sh probe
#   RC_SOURCE=... RC_MODULES=... bash run_server_check.sh rounds <policies> <rounds> [opponents] [weights file]
#
# RC_JDK and RC_SERVER_FILES can name the Java folder and the server files directly instead of RC_SOURCE.
# Setup hard links those files, and a memory guard runs from before setup until the script ends.
#
# The server binds to 127.0.0.1 only, so online-mode is off. The RCON password is random and stays in a private file.
set -u
MODE="${1:-probe}"
POLICIES="${2:-scripted}"
ROUNDS="${3:-3}"
OPPONENTS="${4:-zombie,skeleton,creeper,enderman,duelist,guard}"
WEIGHTS="${5:-}"
WORK="$PWD"
rm -f "$WORK/driver.pid" "$WORK/setup.pid" "$WORK/server.pid" "$WORK/LOW_MEMORY"
S="$WORK/server"
JAVA="$WORK/jdk/bin/java"
PORT=25594
RCON_PORT=25595
: "${RC_MIN_FREE_MB:=5200}"  # this job can use 2 GB and the machine keeps 3 GB free for other work
: "${RC_STOP_FREE_MB:=3200}"  # below this the job stops itself, before the 3 GB other jobs rely on is reached
: "${RC_STOP_WINDOWS_MB:=2048}"  # the same for the commit memory Windows has free
: "${RC_WATCH_DISK:=}"  # a folder on the disk to protect, empty to skip this check
: "${RC_STOP_DISK_MB:=5300}"  # below this much free space on that disk the job stops itself
disk_free() { df -m "$RC_WATCH_DISK" 2>/dev/null | awk 'NR==2 {print $4}'; }

if [ -n "${RC_LOCK:-}" ] && [ -e "$RC_LOCK" ]; then echo "waiting file present, not starting"; exit 4; fi
mkdir -p "$S"
# The person running the server accepts the Minecraft EULA. This script never writes or copies that file.
if ! grep -qx 'eula=true' "$S/eula.txt" 2>/dev/null; then
  echo "The Minecraft EULA has not been accepted for this server. Read https://aka.ms/MinecraftEULA"
  echo "If you agree, create $S/eula.txt with the line eula=true"
  exit 5
fi
: "${RC_JDK:=${RC_SOURCE:-}/jdk}"
: "${RC_SERVER_FILES:=${RC_SOURCE:-}/server}"
avail=$(awk '/MemAvailable/ {printf "%d", $2 / 1024}' /proc/meminfo)
if [ "$avail" -lt "$RC_MIN_FREE_MB" ]; then echo "not starting: only $avail MB free"; exit 4; fi
if [ -n "$RC_WATCH_DISK" ]; then
  disk=$(disk_free)
  if ! [[ "$disk" =~ ^[0-9]+$ ]]; then echo "not starting: cannot read free space on $RC_WATCH_DISK"; exit 4; fi
  if [ "$disk" -lt "$RC_STOP_DISK_MB" ]; then echo "not starting: only $disk MB free on disk"; exit 4; fi
fi

PID=""
WATCH=""
stop_server() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID"
    for _ in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
    kill -0 "$PID" 2>/dev/null && kill -KILL "$PID"
    echo "server stopped"
  fi
  rm -f "$WORK/server.pid"
}
trap '[ -n "$WATCH" ] && kill "$WATCH" 2>/dev/null; stop_server' EXIT
trap 'exit 143' TERM INT

# The guard stops whatever this script is running at that moment: a setup copy, the driver or the server
(
  pass=0
  while kill -0 $$ 2>/dev/null; do
    low=""
    now=$(awk '/MemAvailable/ {printf "%d", $2 / 1024}' /proc/meminfo)
    [ "$now" -lt "$RC_STOP_FREE_MB" ] && low="Linux $now MB"
    if [ -n "$RC_WATCH_DISK" ]; then
      disk=$(disk_free)
      if [[ "$disk" =~ ^[0-9]+$ ]] && [ "$disk" -lt "$RC_STOP_DISK_MB" ]; then low="disk $disk MB"; fi
    fi
    if [ $((pass % 3)) -eq 0 ]; then
      win=$(powershell.exe -NoProfile -Command '[int64]((Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory/1024)' </dev/null 2>/dev/null | tr -d '\r' || true)
      if [[ "$win" =~ ^[0-9]+$ ]] && [ "$win" -lt "$RC_STOP_WINDOWS_MB" ]; then low="Windows commit $win MB"; fi
    fi
    if [ -n "$low" ]; then
      echo "stopping: only $low free"
      touch "$WORK/LOW_MEMORY"
      for f in setup.pid driver.pid server.pid; do
        [ -s "$WORK/$f" ] && kill -TERM "$(cat "$WORK/$f")" 2>/dev/null
      done
      break
    fi
    pass=$((pass + 1))
    sleep 10
  done
) &
WATCH=$!

# Runs one setup command with its PID saved, so the guard can stop it
guarded() {
  "$@" &
  local pid=$!
  echo "$pid" > "$WORK/setup.pid"
  wait "$pid"
  local code=$?
  rm -f "$WORK/setup.pid"
  return "$code"
}

# Hard links reuse the file data, so a large folder adds no second copy to the disk or the page cache.
# The result appears in one rename, so an interrupted setup is never taken for a finished one.
place() {
  local from="$1" to="$2"
  [ -e "$to" ] && return 0
  rm -rf "$to.part"
  if ! guarded cp -al "$from" "$to.part" 2>/dev/null; then
    rm -rf "$to.part"
    [ -e "$WORK/LOW_MEMORY" ] && return 1
    guarded cp -r "$from" "$to.part" || { rm -rf "$to.part"; return 1; }
  fi
  mv "$to.part" "$to"
}

# A Java folder without its binary is what an interrupted copy leaves behind
[ -x "$JAVA" ] || rm -rf "$WORK/jdk"
place "$RC_JDK" "$WORK/jdk" || { echo "setup stopped: Java folder"; exit 4; }
for item in paper.jar cache libraries versions; do
  place "$RC_SERVER_FILES/$item" "$S/$item" || { echo "setup stopped: $item"; exit 4; }
done
place "$RC_MODULES" "$WORK/bridge/node_modules" || { echo "setup stopped: node modules"; exit 4; }
if [ -e "$WORK/LOW_MEMORY" ]; then echo "setup stopped: low memory"; exit 4; fi
if [ ! -s "$S/rcon.pw" ]; then
  (umask 077; head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 > "$S/rcon.pw")
fi
(umask 077; cat > "$S/server.properties" <<EOP
server-ip=127.0.0.1
server-port=$PORT
online-mode=false
enforce-secure-profile=false
enable-rcon=true
rcon.port=$RCON_PORT
rcon.password=$(cat "$S/rcon.pw")
broadcast-rcon-to-ops=false
broadcast-console-to-ops=false
enable-query=false
level-name=rcworld
level-type=minecraft\:flat
generator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":62},{"block":"minecraft:smooth_stone","height":1}],"biome":"minecraft:plains"}
generate-structures=false
spawn-protection=0
max-players=40
view-distance=4
simulation-distance=4
difficulty=normal
gamemode=survival
allow-flight=true
spawn-monsters=false
spawn-animals=false
player-idle-timeout=0
pause-when-empty-seconds=-1
network-compression-threshold=-1
sync-chunk-writes=false
EOP
)
avail=$(awk '/MemAvailable/ {printf "%d", $2 / 1024}' /proc/meminfo)
if [ "$avail" -lt "$RC_MIN_FREE_MB" ]; then echo "not starting: only $avail MB free"; exit 4; fi
cd "$S" || exit 1
"$JAVA" -Xms512M -Xmx1G -XX:+UseG1GC -Dterminal.jline=false -Dterminal.ansi=false -jar paper.jar --nogui > "$WORK/server.log" 2>&1 < /dev/null &
PID=$!
echo "$PID" > "$WORK/server.pid"
cd "$WORK"
for _ in $(seq 1 240); do
  grep -q 'Done (' server.log && break
  kill -0 "$PID" 2>/dev/null || { echo "server exited"; tail -20 server.log; exit 1; }
  sleep 1
done
grep -q 'Done (' server.log || { echo "server not ready"; tail -20 server.log; exit 1; }
BIND=$(ss -ltn | awk '{print $4}' | grep -E ":($PORT|$RCON_PORT)\$" | sort -u | tr '\n' ' ')
echo "bound: $BIND"
for b in $BIND; do case "$b" in 127.0.0.1:*|"[::ffff:127.0.0.1]:"*) ;; *) echo "refusing, not localhost: $b"; exit 5 ;; esac; done
cd "$WORK/bridge/realcheck"
if [ "$MODE" = "probe" ]; then
  node --max-old-space-size=500 probe.js --rcon-file "$S/rcon.pw" &
else
  EXTRA=()
  [ -n "$WEIGHTS" ] && EXTRA=(--weights "$WEIGHTS")
  node --max-old-space-size=700 real_side.js --policies "$POLICIES" --rounds "$ROUNDS" --opponents "$OPPONENTS" --rcon-file "$S/rcon.pw" --out "$WORK/real.json" "${EXTRA[@]}" &
fi
DRIVER=$!
echo "$DRIVER" > "$WORK/driver.pid"
wait "$DRIVER"
code=$?
rm -f "$WORK/driver.pid"
echo "driver exit $code"
exit "$code"
