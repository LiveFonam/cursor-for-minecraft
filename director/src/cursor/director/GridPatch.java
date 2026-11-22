package cursor.director;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

// A what-if copy of a Grid: blocks taken out or put in for a test. The world itself is never touched.
public final class GridPatch implements Grid {
    // a block put in for a test is as strong as dirt, the weakest thing an enderman would carry
    static final float PLACED_BLAST = 0.5f;

    private final Grid base;
    private final Set<Long> removed = new HashSet<>();
    private final Set<Long> placed = new HashSet<>();

    public GridPatch(Grid base) { this.base = base; }

    public void remove(int x, int y, int z) {
        long k = Shelter.key(x, y, z);
        placed.remove(k);
        removed.add(k);
    }

    public void place(int x, int y, int z) {
        long k = Shelter.key(x, y, z);
        removed.remove(k);
        placed.add(k);
    }

    public List<int[]> removedBlocks() {
        List<int[]> out = new ArrayList<>();
        for (long k : removed) out.add(Reach.unkey(k));
        return out;
    }

    private boolean isRemoved(int x, int y, int z) { return removed.contains(Shelter.key(x, y, z)); }

    private boolean isPlaced(int x, int y, int z) { return placed.contains(Shelter.key(x, y, z)); }

    @Override public boolean passable(int x, int y, int z) {
        if (isPlaced(x, y, z)) return false;
        return isRemoved(x, y, z) || base.passable(x, y, z);
    }

    @Override public boolean floor(int x, int y, int z) {
        if (isPlaced(x, y, z)) return true;
        return !isRemoved(x, y, z) && base.floor(x, y, z);
    }

    @Override public float blast(int x, int y, int z) {
        if (isPlaced(x, y, z)) return PLACED_BLAST;
        return isRemoved(x, y, z) ? 0f : base.blast(x, y, z);
    }

    @Override public boolean gate(int x, int y, int z) {
        return !isPlaced(x, y, z) && !isRemoved(x, y, z) && base.gate(x, y, z);
    }

    @Override public boolean water(int x, int y, int z) {
        return !isPlaced(x, y, z) && !isRemoved(x, y, z) && base.water(x, y, z);
    }

    @Override public boolean loaded(int x, int y, int z) { return base.loaded(x, y, z); }
}
