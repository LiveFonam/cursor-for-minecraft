#!/usr/bin/env python3
"""Builds the crafter's recipe file from a local Minecraft server jar.

    python3 bridge/danger_sensing_agents/tools/generate_recipes.py path/to/server.jar

Accepts a vanilla server jar, or a bundler jar that holds one under META-INF/versions. The output contains game
data, so it stays on the local machine and is ignored by git.
"""

import argparse
import io
import json
import re
import sys
import zipfile
from pathlib import Path

DEFAULT_OUT = Path(__file__).resolve().parent.parent / "recipes" / "all-recipes-1.21.11.json"
RECIPE_DIR = "data/minecraft/recipe/"
TAG_DIR = "data/minecraft/tags/item/"


def open_server(path):
    """Return the zip that holds the game data and its version."""
    outer = zipfile.ZipFile(path)
    for name in outer.namelist():
        found = re.fullmatch(r"META-INF/versions/([^/]+)/server-[^/]+\.jar", name)
        if found:
            return zipfile.ZipFile(io.BytesIO(outer.read(name))), found.group(1)
    if "version.json" in outer.namelist():
        return outer, json.loads(outer.read("version.json"))["id"]
    sys.exit(f"{path} is not a Minecraft server jar")


def read_tree(jar, prefix):
    """Read every JSON file under a folder, keyed by its path without the extension."""
    return {
        name[len(prefix):-len(".json")]: json.loads(jar.read(name))
        for name in jar.namelist()
        if name.startswith(prefix) and name.endswith(".json")
    }


def build(jar_path):
    jar, version = open_server(jar_path)
    recipes = read_tree(jar, RECIPE_DIR)
    if not recipes:
        sys.exit(f"{jar_path} holds no recipes")
    tags = read_tree(jar, TAG_DIR)
    return {
        "item_tags": {name: tag["values"] for name, tag in tags.items()},
        "recipes": recipes,
        "source": f"{Path(jar_path).name} data/minecraft",
        "version": version,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("jar", help="a Minecraft 1.21.11 server jar")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    data = build(args.jar)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n")
    print(f"wrote {len(data['recipes'])} recipes and {len(data['item_tags'])} item tags to {args.out}")


if __name__ == "__main__":
    main()
