package cursor.director;

import java.util.HashMap;
import java.util.Map;

// One planning pass reads the same blocks many times. This remembers each block the first time it is read, and never
// asks about a block outside the loaded area, so planning cannot make the server load a chunk. Make a new one for each
// pass: it does not see later changes in the world.
final class Snapshot implements Grid {
    private record Cell(boolean loaded, boolean passable, boolean floor, boolean gate, boolean water, float blast) {}

    private static final Cell UNLOADED = new Cell(false, false, false, false, false, Float.MAX_VALUE);

    private final Grid g;
    private final Map<Long, Cell> cells = new HashMap<>(1 << 14);

    private Snapshot(Grid g) { this.g = g; }

    static Grid of(Grid g) { return g instanceof Snapshot ? g : new Snapshot(g); }

    private Cell at(int x, int y, int z) {
        long k = Shelter.key(x, y, z);
        Cell c = cells.get(k);
        if (c == null) {
            c = !g.loaded(x, y, z) ? UNLOADED
                : new Cell(true, g.passable(x, y, z), g.floor(x, y, z), g.gate(x, y, z), g.water(x, y, z), g.blast(x, y, z));
            cells.put(k, c);
        }
        return c;
    }

    @Override public boolean passable(int x, int y, int z) { return at(x, y, z).passable; }
    @Override public boolean floor(int x, int y, int z) { return at(x, y, z).floor; }
    @Override public float blast(int x, int y, int z) { return at(x, y, z).blast; }
    @Override public boolean gate(int x, int y, int z) { return at(x, y, z).gate; }
    @Override public boolean water(int x, int y, int z) { return at(x, y, z).water; }
    @Override public boolean loaded(int x, int y, int z) { return at(x, y, z).loaded; }
}
