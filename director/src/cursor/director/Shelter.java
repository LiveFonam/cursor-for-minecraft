package cursor.director;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

// Is the player shut in, and where could a creeper blast a way in? Pure, read from a Grid, so the tests run it on
// a map of blocks. Re-read every time it is asked: when the player opens a gate, closes it, walls it with obsidian
// or digs further, the answer changes with the blocks.
//
// The shut-in space is every spot a zombie could walk to from the player's feet: one block of floor under two blocks
// of air, stepping up one block or dropping up to three, like mob movement. If that space reaches farther than
// `radius` from the player, the player is out in the open. Otherwise it is a shelter, and its walls are the blocks
// around it. A breach is a wall (or a roof) at most `maxThickness` blocks thick, every block of it weaker than
// `maxBlast`, with a spot just outside where a creeper can stand.
public final class Shelter {
    public enum Kind { GATE, WALL, ROOF }

    public static final class Breach {
        public final Kind kind;
        public final int[] block;       // the first block of the wall, seen from inside
        public final int[] stand;       // where the creeper stands (its feet), outside
        public final int[] inside;      // the shelter spot behind the wall
        public final int thickness;
        public final float blast;       // the strongest block in the way
        public final int[] out;         // the way out, from inside to the creeper (dx, dy, dz)

        Breach(Kind kind, int[] block, int[] stand, int[] inside, int thickness, float blast, int[] out) {
            this.kind = kind; this.block = block; this.stand = stand; this.inside = inside;
            this.thickness = thickness; this.blast = blast; this.out = out;
        }

        @Override public String toString() {
            return String.format("%s %d thick at %d %d %d (creeper stands at %d %d %d)", kind.name().toLowerCase(), thickness,
                block[0], block[1], block[2], stand[0], stand[1], stand[2]);
        }
    }

    public static final class Result {
        public boolean enclosed;            // shut in: no walk out of `radius`
        public int cells;                   // how many spots inside
        public final Set<Long> inside = new HashSet<>();
        public final List<Breach> breaches = new ArrayList<>();
        public final List<int[]> gates = new ArrayList<>();   // closed gates and doors in its walls (the way in)
        public String why = "";

        public boolean contains(int x, int y, int z) { return inside.contains(key(x, y, z)); }
    }

    public static final int[][] DIRS = { { 1, 0, 0 }, { -1, 0, 0 }, { 0, 0, 1 }, { 0, 0, -1 } };

    public static long key(int x, int y, int z) {
        return ((long) (x & 0x3FFFFFF) << 38) | ((long) (z & 0x3FFFFFF) << 12) | (y & 0xFFF);
    }

    // A spot a mob can stand in: floor below, room for its body
    public static boolean standable(Grid g, int x, int y, int z) {
        return g.loaded(x, y, z) && g.passable(x, y, z) && g.passable(x, y + 1, z) && g.floor(x, y - 1, z);
    }

    public static Result analyze(Grid g, int px, int py, int pz, int radius, int maxThickness, float maxBlast) {
        Result r = new Result();
        // the player may stand on a slab or in tall grass: their spot is the first standable one at or just below
        int sy = py;
        for (int k = 0; k < 3 && !standable(g, px, sy, pz); k++) sy--;
        if (!standable(g, px, sy, pz)) {
            r.enclosed = false;
            r.why = "the player is not standing on anything a mob could walk to";
            return r;
        }
        ArrayDeque<int[]> queue = new ArrayDeque<>();
        queue.add(new int[] { px, sy, pz });
        r.inside.add(key(px, sy, pz));
        int limit = (2 * radius + 1) * (2 * radius + 1) * 6;
        while (!queue.isEmpty()) {
            int[] c = queue.poll();
            if (Math.max(Math.abs(c[0] - px), Math.abs(c[2] - pz)) > radius) {
                r.enclosed = false;
                r.why = String.format("a mob can walk in from %d blocks out", radius);
                r.cells = r.inside.size();
                return r;
            }
            if (r.inside.size() > limit) { r.enclosed = false; r.why = "the space around the player is too big to be a shelter"; return r; }
            for (int[] d : DIRS) {
                int x = c[0] + d[0], z = c[2] + d[2], y = c[1];
                int[] next = null;
                if (standable(g, x, y, z)) next = new int[] { x, y, z };
                // a step up: the block in front is a floor, with room above it and above our head
                else if (standable(g, x, y + 1, z) && g.passable(c[0], y + 2, c[2])) next = new int[] { x, y + 1, z };
                // a drop of up to 3 blocks
                else if (g.passable(x, y, z) && g.passable(x, y + 1, z)) {
                    for (int k = 1; k <= 3; k++) {
                        if (!g.passable(x, y - k + 1, z)) break;
                        if (standable(g, x, y - k, z)) { next = new int[] { x, y - k, z }; break; }
                    }
                }
                if (next == null) continue;
                long k = key(next[0], next[1], next[2]);
                if (r.inside.add(k)) queue.add(next);
            }
        }
        r.enclosed = true;
        r.cells = r.inside.size();
        findBreaches(g, r, px, sy, pz, maxThickness, maxBlast);
        r.why = r.breaches.isEmpty()
            ? String.format("shut in (%d spots), no wall or roof thin and weak enough to blast", r.cells)
            : String.format("shut in (%d spots), %d places to blast", r.cells, r.breaches.size());
        return r;
    }

    private static void findBreaches(Grid g, Result r, int px, int py, int pz, int maxThickness, float maxBlast) {
        Map<Long, Breach> byStand = new LinkedHashMap<>();
        Set<Long> gatesSeen = new HashSet<>();
        for (long k : r.inside) {
            int x = (int) (k >> 38), z = (int) ((k >> 12) & 0x3FFFFFF), y = (int) (k & 0xFFF);
            x = (x << 6) >> 6; z = (z << 6) >> 6; y = (y << 20) >> 20;  // back to signed
            // walls, four ways
            for (int[] d : DIRS) {
                int wx = x + d[0], wz = z + d[2];
                if (g.passable(wx, y, wz) && g.passable(wx, y + 1, wz)) continue;  // no wall here (a hole or a drop)
                boolean isGate = g.gate(wx, y, wz) || g.gate(wx, y + 1, wz);
                if (isGate && gatesSeen.add(key(wx, y, wz))) r.gates.add(new int[] { wx, y, wz });
                float strongest = 0;
                boolean weak = true;
                for (int t = 1; t <= maxThickness && weak; t++) {
                    int bx = x + d[0] * t, bz = z + d[2] * t;
                    for (int dy = 0; dy <= 1; dy++) {
                        if (!g.passable(bx, y + dy, bz)) {
                            strongest = Math.max(strongest, g.blast(bx, y + dy, bz));
                            if (g.blast(bx, y + dy, bz) > maxBlast) weak = false;
                        }
                    }
                    if (!weak) break;
                    // the spot just past this much wall, at the same height or one up or down
                    int sx = x + d[0] * (t + 1), sz = z + d[2] * (t + 1);
                    for (int dy : new int[] { 0, 1, -1 }) {
                        if (!standable(g, sx, y + dy, sz) || r.contains(sx, y + dy, sz)) continue;
                        Kind kind = isGate ? Kind.GATE : Kind.WALL;
                        Breach b = new Breach(kind, new int[] { wx, y, wz }, new int[] { sx, y + dy, sz }, new int[] { x, y, z }, t, strongest, d);
                        byStand.merge(key(sx, y + dy, sz), b, Shelter::better);
                        weak = false;  // the thinnest way through this wall is enough
                        break;
                    }
                }
            }
            // the roof: blocks over the head, at most maxThickness, with ground on top for a creeper to stand on
            if (g.passable(x, y + 2, z)) continue;
            float strongest = 0;
            for (int t = 1; t <= maxThickness; t++) {
                int by = y + 1 + t;
                if (g.passable(x, by, z)) break;
                strongest = Math.max(strongest, g.blast(x, by, z));
                if (g.blast(x, by, z) > maxBlast) break;
                int sy = by + 1;
                if (standable(g, x, sy, z) && !r.contains(x, sy, z)) {
                    Breach b = new Breach(Kind.ROOF, new int[] { x, y + 2, z }, new int[] { x, sy, z }, new int[] { x, y, z }, t, strongest, new int[] { 0, 1, 0 });
                    byStand.merge(key(x, sy, z), b, Shelter::better);
                    break;
                }
            }
        }
        List<Breach> list = new ArrayList<>(byStand.values());
        // a gate first (it is the weakest part and blowing it opens the way they use), then the thinnest, the weakest,
        // the closest to the player
        list.sort(Comparator.<Breach>comparingInt(b -> b.kind == Kind.GATE ? 0 : 1)
            .thenComparingInt(b -> b.thickness)
            .thenComparingDouble(b -> b.blast)
            .thenComparingDouble(b -> dist2(b.inside, px, py, pz)));
        r.breaches.addAll(list);
    }

    private static Breach better(Breach a, Breach b) {
        if (a.kind == Kind.GATE && b.kind != Kind.GATE) return a;
        if (b.kind == Kind.GATE && a.kind != Kind.GATE) return b;
        return a.thickness <= b.thickness ? a : b;
    }

    static double dist2(int[] a, int x, int y, int z) {
        double dx = a[0] - x, dy = a[1] - y, dz = a[2] - z;
        return dx * dx + dy * dy + dz * dz;
    }
}
