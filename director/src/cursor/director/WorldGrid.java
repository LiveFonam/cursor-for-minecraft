package cursor.director;

import org.bukkit.Material;
import org.bukkit.Tag;
import org.bukkit.World;
import org.bukkit.block.Block;

// The live world as a Grid: every question reads the block as it is right now
final class WorldGrid implements Grid {
    private final World w;

    WorldGrid(World w) { this.w = w; }

    private Block at(int x, int y, int z) { return w.getBlockAt(x, y, z); }

    @Override public boolean passable(int x, int y, int z) {
        if (y < w.getMinHeight() || y >= w.getMaxHeight()) return false;
        Block b = at(x, y, z);
        Material m = b.getType();
        // no collision, but no mob walks through these
        if (m == Material.LAVA || m == Material.FIRE || m == Material.SOUL_FIRE || m == Material.POWDER_SNOW || m == Material.SWEET_BERRY_BUSH || m == Material.COBWEB) return false;
        return b.isPassable();
    }

    @Override public boolean floor(int x, int y, int z) {
        if (y < w.getMinHeight() || y >= w.getMaxHeight()) return false;
        Material m = at(x, y, z).getType();
        if (!m.isSolid()) return false;
        // 1.5 high: nothing climbs onto them
        return !Tag.FENCES.isTagged(m) && !Tag.WALLS.isTagged(m) && !Tag.FENCE_GATES.isTagged(m) && m != Material.CACTUS && m != Material.MAGMA_BLOCK;
    }

    @Override public float blast(int x, int y, int z) { return at(x, y, z).getType().getBlastResistance(); }

    @Override public boolean gate(int x, int y, int z) {
        Material m = at(x, y, z).getType();
        return Tag.FENCE_GATES.isTagged(m) || Tag.DOORS.isTagged(m) || Tag.TRAPDOORS.isTagged(m);
    }

    @Override public boolean loaded(int x, int y, int z) {
        return y >= w.getMinHeight() && y < w.getMaxHeight() && w.isChunkLoaded(x >> 4, z >> 4);
    }
}
