#!/usr/bin/env bash
#
# Downloads a Paper server into the gitignored server folder.
# It does not start the server, and it never accepts the Minecraft EULA.
# The person running the server reads the EULA and accepts it themselves.

set -euo pipefail

PAPER_VERSION="${PAPER_VERSION:-1.21.11}"
JAVA_MAJOR=21
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="${AGENTS_SERVER_DIR:-$SCRIPT_DIR/../server}"
API_BASE="${AGENTS_PAPER_API:-https://fill.papermc.io/v3}"
BUILD_URL="$API_BASE/projects/paper/versions/$PAPER_VERSION/builds/latest"
EULA_URL="https://aka.ms/MinecraftEULA"

fail() {
  echo "Error: $1" >&2
  exit 1
}

need_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found."
}

java_major() {
  # On a Mac without Java, /usr/bin/java exists but exits with an error.
  local output
  output="$(java -version 2>&1)" || return 1
  printf '%s\n' "$output" | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -n 1
}

report_java() {
  local major
  major="$(java_major || true)"
  if [ -n "$major" ] && [ "$major" -ge "$JAVA_MAJOR" ]; then
    echo "Java $major found."
    return 0
  fi
  echo
  echo "Java $JAVA_MAJOR or newer is required to run this server, and it was not found."
  echo "On a Mac, install it with Homebrew:"
  echo "  brew install --cask temurin@$JAVA_MAJOR"
  echo "Other systems can get it from https://adoptium.net"
  return 1
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    sha256sum "$1" | cut -d ' ' -f 1
  fi
}

# Reads one field from the build metadata. Paths are passed as arguments.
read_build() {
  node -e '
    const fs = require("node:fs")
    const build = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const file = build.downloads && build.downloads["server:default"]
    if (!file) process.exit(2)
    const values = { name: file.name, url: file.url, sha256: file.checksums && file.checksums.sha256 }
    const value = values[process.argv[2]]
    if (!value) process.exit(2)
    process.stdout.write(String(value))
  ' "$1" "$2"
}

write_properties() {
  local file="$SERVER_DIR/server.properties"
  [ -e "$file" ] && return 0
  cat > "$file" <<'EOF'
# Written by bridge/danger_sensing_agents/scripts/setup-server.sh for local play.
# offline mode lets the bots join without accounts, so the server only listens on this computer.
online-mode=false
server-ip=127.0.0.1
server-port=25565
EOF
}

write_start_script() {
  local jar="$1"
  cat > "$SERVER_DIR/start.sh" <<EOF
#!/usr/bin/env bash
# Starts the server only after the EULA has been accepted by hand.
set -euo pipefail
cd "\$(dirname "\${BASH_SOURCE[0]}")"
if ! grep -qx 'eula=true' eula.txt 2>/dev/null; then
  echo "The Minecraft EULA has not been accepted."
  echo "Read it at $EULA_URL"
  echo "If you agree, create or edit server/eula.txt so it contains the line eula=true"
  exit 1
fi
exec java -Xms1G -Xmx2G -jar "$jar" --nogui
EOF
  chmod +x "$SERVER_DIR/start.sh"
}

main() {
  need_tool curl
  need_tool node

  mkdir -p "$SERVER_DIR"
  # Global, because the exit trap runs after this function has returned.
  work="$(mktemp -d "$SERVER_DIR/.download.XXXXXX")"
  trap 'rm -rf "$work"' EXIT

  echo "Looking up the latest Paper $PAPER_VERSION build."
  curl -fsSL --max-time 30 "$BUILD_URL" -o "$work/build.json" \
    || fail "Could not read build information from $BUILD_URL"

  local name url expected
  name="$(read_build "$work/build.json" name)" || fail "Build information has no file name."
  url="$(read_build "$work/build.json" url)" || fail "Build information has no download link."
  expected="$(read_build "$work/build.json" sha256)" || fail "Build information has no checksum."

  case "$name" in
    */*|*..*|.*|*[!A-Za-z0-9._-]*) fail "Unexpected file name in build information: $name" ;;
    *.jar) ;;
    *) fail "Unexpected file name in build information: $name" ;;
  esac

  if [ -f "$SERVER_DIR/$name" ] && [ "$(sha256_of "$SERVER_DIR/$name")" = "$expected" ]; then
    echo "$name is already downloaded."
  else
    echo "Downloading $name."
    curl -fL --max-time 600 --progress-bar "$url" -o "$work/$name" || fail "Download failed."
    local actual
    actual="$(sha256_of "$work/$name")"
    [ "$actual" = "$expected" ] || fail "Checksum mismatch for $name. The file was not installed."
    mv "$work/$name" "$SERVER_DIR/$name"
  fi

  write_properties
  write_start_script "$name"

  echo
  echo "Server files are in $SERVER_DIR"
  local java_ok=0
  report_java || java_ok=1

  echo
  echo "Before the server can run:"
  local step=1
  if [ "$java_ok" -ne 0 ]; then
    echo "  $step. Install Java $JAVA_MAJOR as shown above."
    step=$((step + 1))
  fi
  echo "  $step. Read the Minecraft EULA at $EULA_URL"
  step=$((step + 1))
  echo "  $step. If you agree, create server/eula.txt yourself with the line eula=true"
  step=$((step + 1))
  echo "  $step. Start the server with server/start.sh"
  echo
  echo "This script did not accept the EULA for you."
}

main "$@"
