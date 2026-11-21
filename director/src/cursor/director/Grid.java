package cursor.director;

// What the shelter analysis needs to know about one block. WorldGrid reads it from the live world, the tests use a
// plain map, so Shelter has no Minecraft in it.
public interface Grid {
    // a mob's body fits through it (air, grass, an open gate or door, not a closed gate, a fence or glass)
    boolean passable(int x, int y, int z);

    // a mob can stand on top of it (a full block, not a fence, a wall or a gate, which are 1.5 high)
    boolean floor(int x, int y, int z);

    // the block's blast resistance (cobblestone 6, planks and fence gates 3, obsidian 1200)
    float blast(int x, int y, int z);

    // a gate, door or trapdoor: the way in a player closes behind them
    boolean gate(int x, int y, int z);

    // a block the world has loaded (outside the loaded area nothing counts)
    default boolean loaded(int x, int y, int z) { return true; }
}
