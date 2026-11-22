"""Command line entry points."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def smoke(args: argparse.Namespace) -> int:
    from .evaluate import play_matches
    from .opponents import LEAGUE
    from .policy import NumpyPolicy
    from .train import Stage, TrainConfig, train

    stages = [
        Stage("targets", {"idle": 1.0, "random": 1.0}, 0.75, 10_000),
        Stage("chasers", {"swinger": 1.0, "random": 1.0}, 0.50, 20_000),
        Stage("league", {LEAGUE: 1.0, "random": 1.0, "swinger": 1.0}, 2.0, 0, 0.6),
    ]
    cfg = TrainConfig(
        out=args.out,
        total_steps=args.steps,
        n_envs=16,
        n_steps=128,
        batch_size=1024,
        n_epochs=3,
        snapshot_every=25_000,
        checkpoint_every=50_000,
        max_minutes=args.max_minutes,
        seed=args.seed,
        stages=stages,
    )
    summary = train(cfg)
    policy = NumpyPolicy.load(Path(args.out) / "policy.npz")
    trained = play_matches(policy, "random")
    untrained = play_matches(NumpyPolicy.random(seed=args.seed), "random")
    passed = trained["win_rate"] >= 0.6 and trained["win_rate_low"] > untrained["win_rate_high"]
    result = {"train": summary, "trained": trained, "untrained": untrained, "passed": passed}
    (Path(args.out) / "smoke.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    return 0 if passed else 1


def full(args: argparse.Namespace) -> int:
    from .train import TrainConfig, train

    cfg = TrainConfig(
        out=args.out,
        total_steps=args.steps,
        n_envs=args.envs,
        seed=args.seed,
        max_minutes=args.max_minutes,
        max_rss_gb=args.max_rss_gb,
    )
    print(json.dumps(train(cfg, resume=args.resume), indent=2))
    return 0


def drill(args: argparse.Namespace) -> int:
    from .drills import train_drill

    out = args.out or f"runs/drill-{args.name}"
    report = train_drill(args.name, out, steps=args.steps, seed=args.seed, max_minutes=args.max_minutes)
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


def evaluate(args: argparse.Namespace) -> int:
    from .drills import DRILLS
    from .evaluate import play_matches
    from .opponents import SCRIPTED
    from .policy import NumpyPolicy

    policy = NumpyPolicy.load(args.policy)
    if args.drill:
        report = DRILLS[args.drill][1](policy)
        print(json.dumps(report, indent=2))
        return 0 if report["passed"] else 1
    names = sorted(SCRIPTED) if args.opponent == "all" else [args.opponent]
    results = [
        play_matches(policy, name, games_per_arena=args.games, deterministic=args.deterministic)
        for name in names
    ]
    print(json.dumps(results, indent=2))
    return 0


def campaign(args: argparse.Namespace) -> int:
    from .campaign import main as campaign_main

    return campaign_main(args.rest)


def evolve(args: argparse.Namespace) -> int:
    from .evolve import main as evolve_main

    return evolve_main(args.rest)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fighter", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    p = commands.add_parser("smoke", help="short train that must beat a random opponent")
    p.add_argument("--out", default="runs/smoke")
    p.add_argument("--steps", type=int, default=300_000)
    p.add_argument("--max-minutes", type=float, default=8.0)
    p.add_argument("--seed", type=int, default=7)
    p.set_defaults(run=smoke)

    p = commands.add_parser("train", help="full curriculum and league training")
    p.add_argument("--out", default="runs/full")
    p.add_argument("--steps", type=int, default=30_000_000)
    p.add_argument("--envs", type=int, default=32)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--max-minutes", type=float, default=0.0)
    p.add_argument("--max-rss-gb", type=float, default=2.0)
    p.add_argument("--resume", action="store_true")
    p.set_defaults(run=full)

    p = commands.add_parser("drill", help="train a skill drill and run its pass test")
    p.add_argument("name", choices=["shooting", "blocking"])
    p.add_argument("--out", default=None)
    p.add_argument("--steps", type=int, default=2_000_000)
    p.add_argument("--max-minutes", type=float, default=30.0)
    p.add_argument("--seed", type=int, default=11)
    p.set_defaults(run=drill)

    p = commands.add_parser("evaluate", help="evaluate a saved policy on held-out seeds")
    p.add_argument("--policy", required=True)
    p.add_argument("--opponent", default="all")
    p.add_argument("--games", type=int, default=8, help="games per arena, with 25 arenas")
    p.add_argument("--deterministic", action="store_true")
    p.add_argument("--drill", choices=["shooting", "blocking"], default=None)
    p.set_defaults(run=evaluate)

    p = commands.add_parser("campaign", help="train the experts and the fighter together, see `campaign -h`")
    p.add_argument("rest", nargs=argparse.REMAINDER)
    p.set_defaults(run=campaign)

    p = commands.add_parser("evolve", help="breed fighters from the best runs, see `evolve -h`")
    p.add_argument("rest", nargs=argparse.REMAINDER)
    p.set_defaults(run=evolve)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return args.run(args)


if __name__ == "__main__":
    raise SystemExit(main())
