#!/bin/bash
# Checks one trained fighter: the same rounds in the simulator and on a private real server, then the gap report.
#
#   RC_SIM_PYTHON=<python> RC_SIM_SRC=<simulator src> RC_MOB_SRC=<src with mobs> \
#   RC_RUNNER=<job command> RC_SOURCE=<worker folder with server/ and jdk/> RC_MODULES=<worker node_modules> \
#   bash check_trained.sh <campaign folder> [rounds] [job name]
#
# RC_RUNNER names the command that sends work to the worker machine (send, run, state, log, fetch). The report is written to
# realcheck-<job name>/report.md in the current folder.
set -euo pipefail
RUN="$1"
ROUNDS="${2:-150}"
JOB="${3:-rc-trained}"
RUNNER="${RC_RUNNER:?set RC_RUNNER to the command that sends work to the worker machine}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$PWD/realcheck-$JOB"
BUNDLE="$OUT/bundle"
MOBS=zombie,skeleton,creeper,enderman
BOTS=duelist,guard
mkdir -p "$BUNDLE/bridge/realcheck"
cp "$HERE"/../{fighter.js,fair_health.js,mineflayer_fixes.js,patch-physics.js,rcon.js,package.json} "$BUNDLE/bridge/"
cp "$HERE"/{real_side.js,probe.js,policies.js,net.js,spec.json,run_server_check.sh} "$BUNDLE/bridge/realcheck/"

PYTHONPATH="$RC_SIM_SRC:$HERE" "$RC_SIM_PYTHON" "$HERE/export_policy.py" --run "$RUN" --out "$BUNDLE/policy.json"
(cd "$HERE" && PYTHONPATH="$RC_SIM_SRC:$HERE" "$RC_SIM_PYTHON" sim_side.py --policy trained --weights "$RUN" --opponents "$BOTS" --rounds "$ROUNDS" --out "$OUT/sim_bots.json")
(cd "$HERE" && PYTHONPATH="$RC_MOB_SRC:$HERE" "$RC_SIM_PYTHON" sim_side.py --policy trained --weights "$RUN" --opponents "$MOBS" --rounds "$ROUNDS" --out "$OUT/sim_mobs.json")

"$RUNNER" send "$JOB" "$BUNDLE"
"$RUNNER" run "$JOB" 2 "RC_SOURCE=$RC_SOURCE RC_MODULES=$RC_MODULES bash bridge/realcheck/run_server_check.sh rounds trained $ROUNDS $MOBS,$BOTS \$PWD/policy.json"
while [ "$("$RUNNER" state "$JOB")" = "running" ]; do sleep 30; done
"$RUNNER" log "$JOB" 30
"$RUNNER" fetch "$JOB" "$OUT/fetched"
REAL=$(find "$OUT/fetched" -name real.json | head -1)
(cd "$HERE" && "$RC_SIM_PYTHON" compare.py --sim "$OUT/sim_bots.json" "$OUT/sim_mobs.json" --real "$REAL" --out "$OUT/report.md")
