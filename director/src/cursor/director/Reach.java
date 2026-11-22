package cursor.director;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

// Where a zombie can really walk, read from a Grid. The same moves as Shelter (step up one, drop up to three), plus
// water: a mob wades through water up to its knees but does not walk along the bottom with its head under.
public final class Reach {
    private Reach() {}

    // Every spot the walkers can get to, with the number of moves to it
    public static final class Walk {
        final Map<Long, Integer> steps = new LinkedHashMap<>();
        final Map<Long, Long> from = new HashMap<>();

        public boolean has(int[] c) { return c != null && steps.containsKey(Shelter.key(c[0], c[1], c[2])); }

        public int steps(int[] c) {
            Integer s = c == null ? null : steps.get(Shelter.key(c[0], c[1], c[2]));
            return s == null ? -1 : s;
        }

        public int size() { return steps.size(); }

        public Collection<Long> cells() { return steps.keySet(); }

        // the walk from a start to this spot, start first
        public List<int[]> pathTo(int[] c) {
            List<int[]> out = new ArrayList<>();
            if (!has(c)) return out;
            Long k = Shelter.key(c[0], c[1], c[2]);
            while (k != null) {
                out.add(unkey(k));
                k = from.get(k);
            }
            Collections.reverse(out);
            return out;
        }
    }

    public static int[] unkey(long k) {
        int x = (int) (k >> 38), z = (int) ((k >> 12) & 0x3FFFFFF), y = (int) (k & 0xFFF);
        return new int[] { (x << 6) >> 6, (y << 20) >> 20, (z << 6) >> 6 };
    }

    // floor below, room for the body, and the head is not under water
    public static boolean canStand(Grid g, int x, int y, int z) {
        return Shelter.standable(g, x, y, z) && !(g.water(x, y, z) && g.water(x, y + 1, z));
    }

    // the first spot a mob could stand at, at or just below this position
    public static int[] snap(Grid g, int[] p) {
        for (int k = 0; k < 3; k++) if (canStand(g, p[0], p[1] - k, p[2])) return new int[] { p[0], p[1] - k, p[2] };
        return null;
    }

    // The same world for a mob that keeps walking along the bottom with its head under water
    public static Grid ignoringWater(Grid g) {
        return new Grid() {
            @Override public boolean passable(int x, int y, int z) { return g.passable(x, y, z); }
            @Override public boolean floor(int x, int y, int z) { return g.floor(x, y, z); }
            @Override public float blast(int x, int y, int z) { return g.blast(x, y, z); }
            @Override public boolean gate(int x, int y, int z) { return g.gate(x, y, z); }
            @Override public boolean loaded(int x, int y, int z) { return g.loaded(x, y, z); }
        };
    }

    // where someone at this spot ends up once blasts have taken the ground from under them, or null
    public static int[] landing(Grid g, int[] c) {
        for (int y = c[1]; y >= c[1] - 8; y--) {
            if (canStand(g, c[0], y, c[2])) return new int[] { c[0], y, c[2] };
            if (!g.passable(c[0], y, c[2])) return null;
        }
        return null;
    }

    public static List<int[]> moves(Grid g, int x, int y, int z) {
        List<int[]> out = new ArrayList<>(4);
        for (int[] d : Shelter.DIRS) {
            int nx = x + d[0], nz = z + d[2];
            if (canStand(g, nx, y, nz)) out.add(new int[] { nx, y, nz });
            else if (canStand(g, nx, y + 1, nz) && g.passable(x, y + 2, z)) out.add(new int[] { nx, y + 1, nz });
            else if (g.passable(nx, y, nz) && g.passable(nx, y + 1, nz)) {
                for (int k = 1; k <= 3; k++) {
                    if (!g.passable(nx, y - k + 1, nz)) break;
                    if (canStand(g, nx, y - k, nz)) { out.add(new int[] { nx, y - k, nz }); break; }
                }
            }
        }
        return out;
    }

    // Every spot reachable from the starts, staying within `radius` of the center (or a little past the farthest start)
    public static Walk flood(Grid g, Collection<int[]> starts, int[] center, int radius, int maxCells) {
        Walk w = new Walk();
        ArrayDeque<int[]> queue = new ArrayDeque<>();
        int reach = radius;
        for (int[] s : starts) {
            int[] c = snap(g, s);
            if (c == null) continue;
            reach = Math.max(reach, Math.max(Math.abs(c[0] - center[0]), Math.abs(c[2] - center[2])) + 2);
            if (w.steps.putIfAbsent(Shelter.key(c[0], c[1], c[2]), 0) == null) queue.add(c);
        }
        while (!queue.isEmpty() && w.steps.size() < maxCells) {
            int[] c = queue.poll();
            long ck = Shelter.key(c[0], c[1], c[2]);
            int at = w.steps.get(ck);
            for (int[] n : moves(g, c[0], c[1], c[2])) {
                if (Math.max(Math.abs(n[0] - center[0]), Math.abs(n[2] - center[2])) > reach) continue;
                long nk = Shelter.key(n[0], n[1], n[2]);
                if (w.steps.putIfAbsent(nk, at + 1) == null) {
                    w.from.put(nk, ck);
                    queue.add(n);
                }
            }
        }
        return w;
    }
}
