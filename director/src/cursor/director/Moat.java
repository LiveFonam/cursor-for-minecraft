package cursor.director;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

// Does water really keep zombies from the player? A strip they can wade or a way around does not. If it does, this
// finds the crossing that needs the fewest blocks and lists them in the order to place them, from the mobs' side.
public final class Moat {
    private Moat() {}

    public enum Verdict {
        NO_WATER,   // no water around, or the mobs walk in without it mattering
        SHORE,      // there is water, but a dry way around it
        SHALLOW,    // the way in wades through water
        STOPS,      // water is what stops them, and a bridge fixes it
        WALLED,     // water stops them, a bridge reaches the land, and a wall still stands in the way
        BLOCKED     // no way in even with a bridge: something else stops them too
    }

    public static final class Plan {
        public Verdict verdict;
        public String why = "";
        public final List<int[]> bridge = new ArrayList<>();   // blocks to place, nearest the mobs first
        public boolean reachesPlayer;                          // the bridge alone opens a walk to the player
        public int walk = -1;                                  // moves to the player once it is done
    }

    private static final int MAX_CELLS = 60000;

    public static Plan analyze(Grid world, int[] player, Collection<int[]> mobs, int radius) {
        Grid g = Snapshot.of(world);
        Plan m = new Plan();
        int[] goal = Reach.snap(g, player);
        if (goal == null) { m.verdict = Verdict.BLOCKED; m.why = "the player is not standing where a mob could"; return m; }
        Reach.Walk walk = Reach.flood(g, mobs, goal, radius, MAX_CELLS);
        boolean anyWater = waterNear(g, goal, radius);
        if (walk.has(goal)) {
            m.walk = walk.steps(goal);
            boolean waded = false;
            for (int[] c : walk.pathTo(goal)) waded |= g.water(c[0], c[1], c[2]);
            m.verdict = waded ? Verdict.SHALLOW : anyWater ? Verdict.SHORE : Verdict.NO_WATER;
            m.why = waded ? "zombies wade across" : anyWater ? "zombies walk around the water" : "no water in the way";
            return m;
        }
        if (!anyWater) { m.verdict = Verdict.NO_WATER; m.why = "no water here, something else stops them"; return m; }

        Crossing x = cheapestBridge(g, goal, walk, radius);
        if (x != null) { m.bridge.addAll(x.blocks); m.reachesPlayer = x.reached; }

        // a zombie can hold its breath: with a sloped bottom it crosses under water and climbs out the far side
        Reach.Walk bottom = Reach.flood(Reach.ignoringWater(g), mobs, goal, radius, MAX_CELLS);
        if (bottom.has(goal)) {
            m.verdict = Verdict.SHALLOW;
            m.walk = bottom.steps(goal);
            m.why = "zombies can cross along the bottom and climb out";
            return m;
        }
        if (x == null || x.blocks.isEmpty()) {
            m.verdict = Verdict.BLOCKED;
            m.why = "a bridge does not help here";
            return m;
        }
        if (!x.reached) {
            m.verdict = Verdict.WALLED;
            m.why = String.format("water stops them, %d blocks bridge it, then a wall is left", x.blocks.size());
            return m;
        }
        GridPatch p = new GridPatch(g);
        for (int[] b : x.blocks) p.place(b[0], b[1], b[2]);
        Reach.Walk after = Reach.flood(p, mobs, goal, radius, MAX_CELLS);
        if (!after.has(goal)) {
            m.verdict = Verdict.BLOCKED;
            m.bridge.clear();
            m.reachesPlayer = false;
            m.why = "the bridge does not open a walk to the player";
            return m;
        }
        m.verdict = Verdict.STOPS;
        m.walk = after.steps(goal);
        m.why = String.format("water stops them, %d blocks bridge it", x.blocks.size());
        return m;
    }

    private record Crossing(List<int[]> blocks, boolean reached) {}

    // Fewest placed blocks from anywhere the mobs can walk to the player: walking costs 0, each bridge block costs 1.
    // If the player cannot be reached at all, the crossing to the dry land closest to them.
    private static Crossing cheapestBridge(Grid g, int[] goal, Reach.Walk walk, int radius) {
        Map<Long, Integer> best = new HashMap<>();
        Map<Long, Long> parent = new HashMap<>();
        Map<Long, int[]> placedFor = new HashMap<>();
        ArrayDeque<int[]> open = new ArrayDeque<>();
        for (long k : walk.cells()) { best.put(k, 0); open.add(Reach.unkey(k)); }
        long goalKey = Shelter.key(goal[0], goal[1], goal[2]);
        int limit = walk.size() + MAX_CELLS;
        while (!open.isEmpty() && best.size() < limit) {
            int[] c = open.pollFirst();
            long ck = Shelter.key(c[0], c[1], c[2]);
            int at = best.get(ck);
            if (ck == goalKey) break;
            for (int[] n : Reach.moves(g, c[0], c[1], c[2])) {
                if (outside(n, goal, radius)) continue;
                long nk = Shelter.key(n[0], n[1], n[2]);
                if (at < best.getOrDefault(nk, Integer.MAX_VALUE)) {
                    best.put(nk, at);
                    parent.put(nk, ck);
                    placedFor.remove(nk);
                    open.addFirst(n);
                }
            }
            for (int[] d : Shelter.DIRS) {
                int[] n = bridgeStep(g, c, c[0] + d[0], c[2] + d[2]);
                if (n == null || outside(n, goal, radius)) continue;
                long nk = Shelter.key(n[0], n[1], n[2]);
                if (at + 1 < best.getOrDefault(nk, Integer.MAX_VALUE)) {
                    best.put(nk, at + 1);
                    parent.put(nk, ck);
                    placedFor.put(nk, new int[] { n[0], n[1] - 1, n[2] });
                    open.addLast(n);
                }
            }
        }
        boolean reached = best.containsKey(goalKey);
        Long end = reached ? Long.valueOf(goalKey) : null;
        if (!reached) {
            double bestD = Double.MAX_VALUE;
            for (Map.Entry<Long, Integer> e : best.entrySet()) {
                if (e.getValue() == 0 || placedFor.containsKey(e.getKey())) continue;   // only dry land across the water
                int[] c = Reach.unkey(e.getKey());
                double score = Shelter.dist2(c, goal[0], goal[1], goal[2]) + e.getValue() * 0.001;
                if (score < bestD) { bestD = score; end = e.getKey(); }
            }
            if (end == null) return null;
        }
        List<int[]> blocks = new ArrayList<>();
        for (Long k = end; k != null; k = parent.get(k)) {
            int[] b = placedFor.get(k);
            if (b != null) blocks.add(0, b);
        }
        return new Crossing(blocks, reached);
    }

    // Standing at c, the spot in the next column if a block were placed on the water there
    private static int[] bridgeStep(Grid g, int[] c, int nx, int nz) {
        for (int fy = c[1] + 1; fy >= c[1] - 3; fy--) {
            if (!g.loaded(nx, fy, nz) || !g.water(nx, fy - 1, nz)) continue;
            if (g.water(nx, fy, nz) || !g.passable(nx, fy, nz) || !g.passable(nx, fy + 1, nz)) continue;
            if (fy > c[1] && !g.passable(c[0], c[1] + 2, c[2])) continue;
            return new int[] { nx, fy, nz };
        }
        return null;
    }

    private static boolean outside(int[] c, int[] center, int radius) {
        return Math.max(Math.abs(c[0] - center[0]), Math.abs(c[2] - center[2])) > radius;
    }

    private static boolean waterNear(Grid g, int[] c, int radius) {
        for (int x = c[0] - radius; x <= c[0] + radius; x++)
            for (int z = c[2] - radius; z <= c[2] + radius; z++)
                for (int y = c[1] - 4; y <= c[1] + 1; y++) if (g.water(x, y, z)) return true;
        return false;
    }

    // Water on most sides of the player, within `radius`: a sign of a moat, for the base detector
    public static boolean ringed(Grid g, int[] c, int radius) {
        int rays = 16, wet = 0;
        for (int i = 0; i < rays; i++) {
            double a = 2 * Math.PI * i / rays;
            ray:
            for (int t = 1; t <= radius; t++) {
                int x = c[0] + (int) Math.round(Math.cos(a) * t), z = c[2] + (int) Math.round(Math.sin(a) * t);
                for (int y = c[1] - 3; y <= c[1]; y++) if (g.water(x, y, z)) { wet++; break ray; }
            }
        }
        return wet >= rays * 0.6;
    }
}
