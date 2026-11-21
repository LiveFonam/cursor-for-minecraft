"""Block, tool and drop tables of the world, written out as a C header at build time.

A cell is one unsigned 16 bit value. The low 8 bits are the block id and the
high 8 bits are its state. Item ids share the block id space below 128, and
items that are not blocks start at 128.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

Y_MIN = -64
Y_MAX = 319
WORLD_HEIGHT = Y_MAX - Y_MIN + 1

# Tool classes. A block stores a bit mask of the classes that match it.
TOOL_NONE = 0
TOOL_PICKAXE = 1
TOOL_SHOVEL = 2
TOOL_AXE = 3
TOOL_SWORD = 4
TOOL_SHEARS = 5

# Tool tiers, as indices into the speed and rank tables.
TIER_HAND = 0
TIER_WOOD = 1
TIER_STONE = 2
TIER_COPPER = 3
TIER_IRON = 4
TIER_DIAMOND = 5
TIER_NETHERITE = 6
TIER_GOLD = 7
TIER_SPEED = (1.0, 2.0, 4.0, 5.0, 6.0, 8.0, 9.0, 12.0)
TIER_RANK = (0, 1, 2, 2, 3, 4, 5, 1)
TIER_DURABILITY = (0, 59, 131, 190, 250, 1561, 2031, 32)

# Lowest harvest rank a block asks for.
NEEDS_ANY = 0
NEEDS_WOOD = 1
NEEDS_STONE = 2
NEEDS_IRON = 3
NEEDS_DIAMOND = 4

# Shape classes used by the collision, targeting and face tables.
SH_EMPTY = 0
SH_FULL = 1
SH_SLAB = 2
SH_STAIRS = 3
SH_DOOR = 4
SH_LADDER = 5
SH_TORCH = 6
SH_FIRE = 7
SH_WEB = 8

# Drop rules beyond a plain item and count range.
DROP_PLAIN = 0
DROP_GRAVEL = 1
DROP_LEAVES = 2

PICK = 1 << TOOL_PICKAXE
SHOVEL = 1 << TOOL_SHOVEL
AXE = 1 << TOOL_AXE
SWORD = 1 << TOOL_SWORD
SHEARS = 1 << TOOL_SHEARS


@dataclass(frozen=True)
class Block:
    """One row of the block table."""

    name: str
    hardness: float
    tools: int = 0
    needs_tool: bool = False
    min_rank: int = NEEDS_ANY
    drop: str | None = None
    drop_min: int = 1
    drop_max: int = 1
    drop_rule: int = DROP_PLAIN
    opaque: bool = True
    solid: bool = True
    replaceable: bool = False
    washable: bool = False
    waterloggable: bool = False
    falls: bool = False
    notable: bool = False
    ignite: int = 0
    burn: int = 0
    shape: int = SH_FULL


def _rock(name: str, hardness: float, drop: str | None = None) -> Block:
    return Block(name, hardness, PICK, True, NEEDS_WOOD, drop or name)


def _ore(name: str, hardness: float, rank: int, drop: str, low: int = 1, high: int = 1) -> Block:
    return Block(name, hardness, PICK, True, rank, drop, low, high, notable=True)


def _open(name: str, **kw) -> Block:
    base = dict(hardness=-1.0, opaque=False, solid=False, shape=SH_EMPTY)
    base.update(kw)
    return Block(name, **base)


BLOCKS: tuple[Block, ...] = (
    _open("air", replaceable=True),
    _rock("stone", 1.5, "cobblestone"),
    _rock("deepslate", 3.0, "cobbled_deepslate"),
    _rock("cobblestone", 2.0),
    _rock("cobbled_deepslate", 3.5),
    _rock("granite", 1.5),
    _rock("diorite", 1.5),
    _rock("andesite", 1.5),
    _rock("tuff", 1.5),
    Block("dirt", 0.5, SHOVEL, drop="dirt"),
    Block("grass_block", 0.6, SHOVEL, drop="dirt"),
    Block("sand", 0.5, SHOVEL, drop="sand", falls=True),
    Block("gravel", 0.6, SHOVEL, drop="gravel", falls=True, drop_rule=DROP_GRAVEL),
    Block("oak_log", 2.0, AXE, drop="oak_log", ignite=5, burn=5),
    Block("oak_planks", 2.0, AXE, drop="oak_planks", ignite=5, burn=20),
    Block(
        "oak_leaves", 0.2, SHEARS, drop=None, drop_rule=DROP_LEAVES, opaque=False,
        waterloggable=True, ignite=30, burn=60,
    ),
    Block(
        "ladder", 0.4, AXE, drop="ladder", opaque=False, solid=False,
        waterloggable=True, shape=SH_LADDER,
    ),
    Block(
        "torch", 0.0, drop="torch", opaque=False, solid=False, washable=True, shape=SH_TORCH,
    ),
    Block(
        "cobweb", 4.0, SWORD | SHEARS, True, NEEDS_ANY, "string", opaque=False, solid=False,
        washable=True, shape=SH_WEB,
    ),
    Block("obsidian", 50.0, PICK, True, NEEDS_DIAMOND, "obsidian"),
    Block("bedrock", -1.0),
    _open("water", replaceable=True, notable=True),
    Block(
        "lava", -1.0, opaque=True, solid=False, replaceable=True, notable=True, shape=SH_EMPTY,
    ),
    _open("fire", hardness=0.0, replaceable=True, washable=True, shape=SH_FIRE),
    Block("barrier", -1.0),
    Block("glass", 0.3, opaque=False),
    _ore("coal_ore", 3.0, NEEDS_WOOD, "coal"),
    _ore("deepslate_coal_ore", 4.5, NEEDS_WOOD, "coal"),
    _ore("copper_ore", 3.0, NEEDS_STONE, "raw_copper", 2, 5),
    _ore("deepslate_copper_ore", 4.5, NEEDS_STONE, "raw_copper", 2, 5),
    _ore("iron_ore", 3.0, NEEDS_STONE, "raw_iron"),
    _ore("deepslate_iron_ore", 4.5, NEEDS_STONE, "raw_iron"),
    _ore("lapis_ore", 3.0, NEEDS_STONE, "lapis_lazuli", 4, 9),
    _ore("deepslate_lapis_ore", 4.5, NEEDS_STONE, "lapis_lazuli", 4, 9),
    _ore("gold_ore", 3.0, NEEDS_IRON, "raw_gold"),
    _ore("deepslate_gold_ore", 4.5, NEEDS_IRON, "raw_gold"),
    _ore("redstone_ore", 3.0, NEEDS_IRON, "redstone", 4, 5),
    _ore("deepslate_redstone_ore", 4.5, NEEDS_IRON, "redstone", 4, 5),
    _ore("diamond_ore", 3.0, NEEDS_IRON, "diamond"),
    _ore("deepslate_diamond_ore", 4.5, NEEDS_IRON, "diamond"),
    Block(
        "cobblestone_slab", 2.0, PICK, True, NEEDS_WOOD, "cobblestone_slab", opaque=False,
        waterloggable=True, shape=SH_SLAB,
    ),
    Block(
        "oak_slab", 2.0, AXE, drop="oak_slab", opaque=False, waterloggable=True,
        ignite=5, burn=20, shape=SH_SLAB,
    ),
    Block(
        "cobblestone_stairs", 2.0, PICK, True, NEEDS_WOOD, "cobblestone_stairs", opaque=False,
        waterloggable=True, shape=SH_STAIRS,
    ),
    Block(
        "oak_stairs", 2.0, AXE, drop="oak_stairs", opaque=False, waterloggable=True,
        ignite=5, burn=20, shape=SH_STAIRS,
    ),
    Block("oak_door", 2.0, AXE, drop="oak_door", opaque=False, shape=SH_DOOR),
    Block(
        "iron_door", 5.0, PICK, True, NEEDS_WOOD, "iron_door", opaque=False, shape=SH_DOOR,
    ),
)

ITEMS: tuple[str, ...] = (
    "coal",
    "raw_copper",
    "raw_iron",
    "raw_gold",
    "redstone",
    "lapis_lazuli",
    "diamond",
    "flint",
    "stick",
    "oak_sapling",
    "string",
)
FIRST_ITEM = 128

BLOCK_ID: dict[str, int] = {b.name: i for i, b in enumerate(BLOCKS)}
ITEM_ID: dict[str, int] = {**BLOCK_ID, **{n: FIRST_ITEM + i for i, n in enumerate(ITEMS)}}

AIR = BLOCK_ID["air"]
STONE = BLOCK_ID["stone"]
DEEPSLATE = BLOCK_ID["deepslate"]
COBBLESTONE = BLOCK_ID["cobblestone"]
GRANITE = BLOCK_ID["granite"]
DIORITE = BLOCK_ID["diorite"]
ANDESITE = BLOCK_ID["andesite"]
TUFF = BLOCK_ID["tuff"]
DIRT = BLOCK_ID["dirt"]
GRASS = BLOCK_ID["grass_block"]
SAND = BLOCK_ID["sand"]
GRAVEL = BLOCK_ID["gravel"]
LOG = BLOCK_ID["oak_log"]
PLANKS = BLOCK_ID["oak_planks"]
LEAVES = BLOCK_ID["oak_leaves"]
LADDER = BLOCK_ID["ladder"]
TORCH = BLOCK_ID["torch"]
COBWEB = BLOCK_ID["cobweb"]
OBSIDIAN = BLOCK_ID["obsidian"]
BEDROCK = BLOCK_ID["bedrock"]
WATER = BLOCK_ID["water"]
LAVA = BLOCK_ID["lava"]
FIRE = BLOCK_ID["fire"]
BARRIER = BLOCK_ID["barrier"]
GLASS = BLOCK_ID["glass"]
COBBLE_SLAB = BLOCK_ID["cobblestone_slab"]
OAK_SLAB = BLOCK_ID["oak_slab"]
COBBLE_STAIRS = BLOCK_ID["cobblestone_stairs"]
OAK_STAIRS = BLOCK_ID["oak_stairs"]
OAK_DOOR = BLOCK_ID["oak_door"]
IRON_DOOR = BLOCK_ID["iron_door"]

WATER_SOURCE = WATER | (8 << 8)
LAVA_SOURCE = LAVA | (8 << 8)

ORE_NAMES = ("coal", "iron", "copper", "gold", "redstone", "lapis", "diamond")
ORE_IDS = {n: (BLOCK_ID[f"{n}_ore"], BLOCK_ID[f"deepslate_{n}_ore"]) for n in ORE_NAMES}

# Face order used across the kernel.
FACE_DOWN, FACE_UP, FACE_NORTH, FACE_EAST, FACE_SOUTH, FACE_WEST = range(6)
# Side order for state bits, matching the flow order north, east, south, west.
NORTH, EAST, SOUTH, WEST = range(4)


def cell(block: int, state: int = 0) -> int:
    """Pack a block id and state byte into a cell value."""
    return (block & 0xFF) | ((state & 0xFF) << 8)


def fluid(block: int, amount: int = 8, falling: bool = False) -> int:
    """Return a water or lava cell with the given amount."""
    return cell(block, (amount & 15) | (int(falling) << 4))


def slab(block: int, kind: int = 0, waterlogged: bool = False) -> int:
    """Return a slab cell. Kind is 0 bottom, 1 top, 2 double."""
    return cell(block, (kind & 3) | (int(waterlogged) << 7))


def stairs(block: int, facing: int, upper: bool = False, shape: int = 0, waterlogged: bool = False) -> int:
    """Return a stairs cell. Shape is 0 straight, 1 and 2 inner, 3 and 4 outer."""
    return cell(block, (facing & 3) | (int(upper) << 2) | ((shape & 7) << 3) | (int(waterlogged) << 7))


def door(block: int, facing: int, is_open: bool = False, hinge: int = 0, upper: bool = False) -> int:
    """Return a door cell."""
    return cell(block, (facing & 3) | (int(is_open) << 2) | ((hinge & 1) << 3) | (int(upper) << 4))


def ladder(facing: int, waterlogged: bool = False) -> int:
    """Return a ladder cell facing away from its support."""
    return cell(LADDER, (facing & 3) | (int(waterlogged) << 7))


def leaves(distance: int = 7, placed: bool = False, waterlogged: bool = False) -> int:
    """Return a leaves cell."""
    return cell(LEAVES, (distance & 7) | (int(placed) << 3) | (int(waterlogged) << 7))


def log(axis: int = 1) -> int:
    """Return a log cell. Axis is 0 x, 1 y, 2 z."""
    return cell(LOG, axis & 3)


def torch(attachment: int = 0) -> int:
    """Return a torch cell. Attachment 0 is the floor, 1 to 4 are walls north to west."""
    return cell(TORCH, attachment & 7)


def fire(age: int = 0) -> int:
    """Return a fire cell."""
    return cell(FIRE, age & 15)


def _c_float_array(name: str, values: list[float]) -> str:
    body = ", ".join(f"{v:.6g}f" if "." in f"{v:.6g}" or "e" in f"{v:.6g}" else f"{v:.1f}f" for v in values)
    return f"static const float {name}[256] = {{{body}}};"


def _c_int_array(name: str, ctype: str, values: list[int]) -> str:
    return f"static const {ctype} {name}[256] = {{{', '.join(str(v) for v in values)}}};"


def header_text() -> str:
    """Return the C header that mirrors these tables."""
    rows = list(BLOCKS) + [Block("unused", -1.0)] * (256 - len(BLOCKS))
    flags: list[int] = []
    for b in rows:
        flags.append(
            int(b.opaque)
            | int(b.solid) << 1
            | int(b.replaceable) << 2
            | int(b.washable) << 3
            | int(b.waterloggable) << 4
            | int(b.falls) << 5
            | int(b.needs_tool) << 6
            | int(b.notable) << 7
        )
    lines = [
        "/* Generated by blocks.py at build time. */",
        "#ifndef BLOCKS_GEN_H",
        "#define BLOCKS_GEN_H",
        "#include <stdint.h>",
        "#define F_OPAQUE 1",
        "#define F_SOLID 2",
        "#define F_REPLACEABLE 4",
        "#define F_WASH 8",
        "#define F_WATERLOG 16",
        "#define F_FALLS 32",
        "#define F_NEEDS_TOOL 64",
        "#define F_NOTABLE 128",
        f"#define SH_EMPTY {SH_EMPTY}",
        f"#define SH_FULL {SH_FULL}",
        f"#define SH_SLAB {SH_SLAB}",
        f"#define SH_STAIRS {SH_STAIRS}",
        f"#define SH_DOOR {SH_DOOR}",
        f"#define SH_LADDER {SH_LADDER}",
        f"#define SH_TORCH {SH_TORCH}",
        f"#define SH_FIRE {SH_FIRE}",
        f"#define SH_WEB {SH_WEB}",
        f"#define DROP_PLAIN {DROP_PLAIN}",
        f"#define DROP_GRAVEL {DROP_GRAVEL}",
        f"#define DROP_LEAVES {DROP_LEAVES}",
        f"#define TOOL_SWORD {TOOL_SWORD}",
        f"#define TOOL_SHEARS {TOOL_SHEARS}",
    ]
    lines += [f"#define B_{b.name.upper()} {i}" for i, b in enumerate(BLOCKS)]
    lines += [f"#define IT_{n.upper()} {FIRST_ITEM + i}" for i, n in enumerate(ITEMS)]
    lines.append(_c_float_array("HARDNESS", [b.hardness for b in rows]))
    lines.append(_c_int_array("FLAGS", "uint8_t", flags))
    lines.append(_c_int_array("SHAPE", "uint8_t", [b.shape for b in rows]))
    lines.append(_c_int_array("TOOLS", "uint8_t", [b.tools for b in rows]))
    lines.append(_c_int_array("MIN_RANK", "uint8_t", [b.min_rank for b in rows]))
    lines.append(_c_int_array("DROP_ID", "uint16_t", [ITEM_ID[b.drop] if b.drop else 0 for b in rows]))
    lines.append(_c_int_array("DROP_MIN", "uint8_t", [b.drop_min for b in rows]))
    lines.append(_c_int_array("DROP_MAX", "uint8_t", [b.drop_max for b in rows]))
    lines.append(_c_int_array("DROP_RULE", "uint8_t", [b.drop_rule for b in rows]))
    lines.append(_c_int_array("IGNITE", "uint8_t", [b.ignite for b in rows]))
    lines.append(_c_int_array("BURN", "uint8_t", [b.burn for b in rows]))
    speeds = ", ".join(f"{s:.1f}f" for s in TIER_SPEED)
    ranks = ", ".join(str(r) for r in TIER_RANK)
    lines.append(f"static const float TIER_SPEED[8] = {{{speeds}}};")
    lines.append(f"static const uint8_t TIER_RANK[8] = {{{ranks}}};")
    lines.append("#endif")
    return "\n".join(lines) + "\n"


def write_header(path: str | Path) -> Path:
    """Write the generated header and return its path."""
    target = Path(path)
    target.write_text(header_text())
    return target
