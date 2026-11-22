"""Compares simulator and real server rounds and reports the gaps with 95% confidence intervals.

    python compare.py --sim sim_scripted.json sim_random.json --real real.json --out report.md
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np

Z = 1.959964
BOOTSTRAPS = 4000
SEED = 20
METRICS = (
    ("win_rate", "win rate"),
    ("damage_dealt", "damage dealt"),
    ("damage_taken", "damage taken"),
    ("melee_hit_rate", "melee hit rate"),
    ("arrow_hit_rate", "arrow hit rate"),
    ("ticks", "round ticks"),
)


def wilson(wins, games):
    if games == 0:
        return 0.0, 1.0
    p = wins / games
    denom = 1 + Z * Z / games
    center = (p + Z * Z / (2 * games)) / denom
    margin = Z * math.sqrt(p * (1 - p) / games + Z * Z / (4 * games * games)) / denom
    return max(center - margin, 0.0), min(center + margin, 1.0)


def newcombe(w1, n1, w2, n2):
    """Interval of p1 - p2 from the two Wilson intervals."""
    p1, p2 = w1 / n1, w2 / n2
    l1, u1 = wilson(w1, n1)
    l2, u2 = wilson(w2, n2)
    gap = p1 - p2
    return gap - math.hypot(p1 - l1, u2 - p2), gap + math.hypot(u1 - p1, p2 - l2)


def arrays(rounds):
    keys = ("win", "damage_dealt", "damage_taken", "swings", "hits", "shots", "arrow_hits", "ticks")
    return {k: np.array([r[k] for r in rounds], dtype=float) for k in keys}


def statistic(data, name, picks):
    """Return the metric for bootstrap resamples, one value per row of picks."""
    if name in ("damage_dealt", "damage_taken", "ticks"):
        return data[name][picks].mean(axis=1)
    top, bottom = ("hits", "swings") if name == "melee_hit_rate" else ("arrow_hits", "shots")
    total = data[bottom][picks].sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(total > 0, data[top][picks].sum(axis=1) / total, np.nan)


def point(data, name):
    if name == "win_rate":
        return float(data["win"].mean())
    return float(statistic(data, name, np.arange(len(data["win"]))[None, :])[0])


def compare_metric(sim, real, name, rng):
    a, b = point(sim, name), point(real, name)
    n_sim, n_real = len(sim["win"]), len(real["win"])
    if name == "win_rate":
        wins_sim, wins_real = int(sim["win"].sum()), int(real["win"].sum())
        sim_ci, real_ci = wilson(wins_sim, n_sim), wilson(wins_real, n_real)
        gap_ci = newcombe(wins_real, n_real, wins_sim, n_sim)
    else:
        s = statistic(sim, name, rng.integers(0, n_sim, (BOOTSTRAPS, n_sim)))
        r = statistic(real, name, rng.integers(0, n_real, (BOOTSTRAPS, n_real)))
        if np.isnan(a) or np.isnan(b):
            return {"sim": a, "real": b, "sim_ci": None, "real_ci": None, "gap": None, "gap_ci": None, "significant": False}
        sim_ci = tuple(np.nanpercentile(s, [2.5, 97.5]).tolist())
        real_ci = tuple(np.nanpercentile(r, [2.5, 97.5]).tolist())
        gap_ci = tuple(np.nanpercentile(r - s, [2.5, 97.5]).tolist())
    return {
        "sim": a, "real": b, "sim_ci": sim_ci, "real_ci": real_ci, "gap": b - a, "gap_ci": gap_ci,
        "significant": bool(gap_ci[0] > 0 or gap_ci[1] < 0),
    }


def read_sim(paths):
    out = {}
    for path in paths:
        saved = json.loads(Path(path).read_text())
        out.setdefault(saved["policy"], {}).update(saved["matchups"])
    return out


def fmt(value, ci, digits):
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "n/a"
    return f"{value:.{digits}f} [{ci[0]:.{digits}f}, {ci[1]:.{digits}f}]" if ci else f"{value:.{digits}f}"


def report(sim, real):
    rng = np.random.default_rng(SEED)
    rows, lines = [], ["# Simulator and real server comparison", ""]
    lines += ["Each cell is the value with its 95% interval. The gap is real minus simulator. Yes marks a gap whose interval excludes 0.", ""]
    for policy in sim:
        lines += [f"## {policy}", "", "| opponent | metric | rounds sim/real | simulator | real | gap | significant |", "|---|---|---|---|---|---|---|"]
        for opponent, sim_rounds in sim[policy].items():
            real_rounds = real.get(policy, {}).get(opponent, [])
            if not real_rounds:
                continue
            a, b = arrays(sim_rounds), arrays(real_rounds)
            for key, label in METRICS:
                c = compare_metric(a, b, key, rng)
                digits = 1 if key == "ticks" else 3 if "rate" in key else 2
                rows.append({"policy": policy, "opponent": opponent, "metric": key, "rounds_sim": len(sim_rounds), "rounds_real": len(real_rounds), **c})
                lines.append(
                    f"| {opponent} | {label} | {len(sim_rounds)}/{len(real_rounds)} | {fmt(c['sim'], c['sim_ci'], digits)} | "
                    f"{fmt(c['real'], c['real_ci'], digits)} | {fmt(c['gap'], c['gap_ci'], digits)} | {'yes' if c['significant'] else 'no'} |"
                )
        lines.append("")
    return rows, "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sim", nargs="+", required=True)
    ap.add_argument("--real", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    real = json.loads(Path(args.real).read_text())["matchups"]
    rows, text = report(read_sim(args.sim), real)
    Path(args.out).write_text(text + "\n")
    Path(args.out).with_suffix(".json").write_text(json.dumps(rows, indent=1))
    print(text)


if __name__ == "__main__":
    main()
