"""Writes a saved fighter and its experts to one JSON file for the real server check.

    python export_policy.py --run <campaign folder> --out policy.json
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from agents_policy import Player  # noqa: E402


def layers_of(policy):
    return [
        {"rows": int(w.shape[0]), "cols": int(w.shape[1]), "w": w.ravel().tolist(), "b": b.ravel().tolist()}
        for w, b in policy.layers
    ]


def export(run):
    player = Player(run)
    experts = [
        {"name": name, "locks": [[int(h), int(k)] for h, k in expert.locks], "layers": layers_of(expert.policy)}
        for name, expert in player.experts.loaded.items()
    ]
    if "mob" in player.experts.loaded:
        raise ValueError("this check covers the shared 130 input experts, the fighter has a mob expert")
    return {"name": player.name, "layers": layers_of(player.policy), "experts": experts}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--run", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    Path(args.out).write_text(json.dumps(export(args.run)))


if __name__ == "__main__":
    main()
