#!/bin/sh
# Installs the packed package into a temporary prefix and runs the installed command against an
# empty Copilot home, outside the checkout.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
export XDG_RUNTIME_DIR="$work/run" COPILOT_HOME="$work/copilot" PATH="$work/prefix/bin:$PATH"
trap 'copilot-viz stop >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
mkdir -p "$XDG_RUNTIME_DIR" "$COPILOT_HOME"
(cd "$root" && npm pack --silent --pack-destination "$work" >/dev/null)
npm install --global --silent --no-audit --no-fund --prefix "$work/prefix" "$work"/copilot-viz-*.tgz
cd "$work"

version=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$root/package.json")
test "$(copilot-viz --version)" = "$version"
copilot-viz --help | grep -q '^Usage: copilot-viz'
if copilot-viz status 2>/dev/null; then echo 'smoke: status succeeded before open' >&2; exit 1; fi

url=$(copilot-viz open --no-open --port 0)
base=${url%%\?*}
node -e 'fetch(process.argv[1]).then((r) => { if (!r.ok) throw new Error(`${r.status} ${r.url}`); })' "${base}icon.svg"
copilot-viz status | grep -q "^running at $base"
copilot-viz stop
if copilot-viz status 2>/dev/null; then echo 'smoke: status succeeded after stop' >&2; exit 1; fi
echo "smoke: copilot-viz $version passed"
