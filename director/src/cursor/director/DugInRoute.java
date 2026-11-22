package cursor.director;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;

// The cheapest way through the ground to a player shut in underground. Walking where mobs can already walk is almost
// free, so an existing cave is used whenever it saves digging. Each block in the way costs its blast resistance. The
// route is then played out blast by blast on a what-if copy of the world, so the list of spots is one that really opens.
public final class DugInRoute {
    private DugInRoute() {}

    public static final class Options {
        public int radius = 32;      // how far mobs are followed on foot
        public int digRadius = 16;   // how far from the player a tunnel may start
        public int depth = 32;
        public float maxBlast = 6f;
        public int maxBlasts = 8;
        public int maxCells = 60000;
    }

    public static final class Spot {
        public final int[] stand;         // where the creeper stands (its feet)
        public final List<int[]> breaks;  // the blocks this blast is expected to break

        Spot(int[] stand, List<int[]> breaks) { this.stand = stand; this.breaks = breaks; }
    }

    public static final class Route {
        public boolean found;
        public String why = "";
        public double cost;
        public int[] start;                                 // where the digging starts
        public boolean fromCave;                            // that spot is under a roof: a cave wall
        public final List<int[]> corridor = new ArrayList<>();
        public final List<int[]> blocks = new ArrayList<>();  // what has to go, nearest the mobs first
        public final List<Spot> blasts = new ArrayList<>();
    }

    private record Node(long key, double cost) {}

    private record Path(double cost, List<int[]> corridor, List<int[]> needed) {}

    public static Route plan(Grid world, int[] player, Collection<int[]> mobs, Options o) {
        Grid g = Snapshot.of(world);
        Route r = new Route();
        int[] goal = Reach.snap(g, player);
        if (goal == null) { r.why = "the player is not standing where a mob could"; return r; }
        Reach.Walk walk = Reach.flood(g, mobs, goal, o.radius, o.maxCells);
        if (walk.size() == 0) { r.why = "no mob has anywhere to stand"; return r; }
        if (walk.has(goal)) {
            r.found = true;
            r.why = "a mob can already walk to the player";
            return r;
        }

        Path first = search(g, goal, walk, o);
        if (first == null) {
            r.why = "every way in is too strong or too long to blast";
            return r;
        }
        r.cost = first.cost;
        r.corridor.addAll(first.corridor);
        r.blocks.addAll(first.needed);
        r.start = first.corridor.get(0);
        r.fromCave = underRoof(g, r.start);
        chain(g, goal, mobs, r, o);
        return r;
    }

    // The cheapest way from anywhere the mobs can walk to the goal, or null
    private static Path search(Grid g, int[] goal, Reach.Walk walk, Options o) {
        Map<Long, Double> best = new HashMap<>();
        Map<Long, Long> parent = new HashMap<>();
        PriorityQueue<Node> open = new PriorityQueue<>((a, b) -> Double.compare(a.cost, b.cost));
        for (long k : walk.cells()) {
            int[] c = Reach.unkey(k);
            if (Math.max(Math.abs(c[0] - goal[0]), Math.abs(c[2] - goal[2])) > o.digRadius || Math.abs(c[1] - goal[1]) > o.depth) continue;
            best.put(k, 0.0);
            open.add(new Node(k, 0));
        }
        double maxCost = o.maxBlasts * 14.0;   // about two blocks of stone per blast
        long goalKey = Shelter.key(goal[0], goal[1], goal[2]);
        int limit = walk.size() + o.maxCells;
        while (!open.isEmpty() && best.size() < limit) {
            Node n = open.poll();
            if (n.cost > best.get(n.key)) continue;
            if (n.key == goalKey || n.cost > maxCost) break;
            int[] c = Reach.unkey(n.key);
            for (int[] d : Shelter.DIRS) {
                for (int dy : new int[] { 0, 1, -1, -2, -3 }) {
                    int tx = c[0] + d[0], ty = c[1] + dy, tz = c[2] + d[2];
                    if (Math.max(Math.abs(tx - goal[0]), Math.abs(tz - goal[2])) > o.digRadius) continue;
                    if (Math.abs(ty - goal[1]) > o.depth || !g.floor(tx, ty - 1, tz)) continue;
                    List<int[]> clear = clearFor(g, c, tx, ty, tz, o.maxBlast);
                    if (clear == null) continue;
                    double cost = n.cost + 0.02;
                    for (int[] b : clear) cost += g.blast(b[0], b[1], b[2]) + 0.3;
                    long tk = Shelter.key(tx, ty, tz);
                    if (cost < best.getOrDefault(tk, Double.MAX_VALUE)) {
                        best.put(tk, cost);
                        parent.put(tk, n.key);
                        open.add(new Node(tk, cost));
                    }
                }
            }
        }
        if (!best.containsKey(goalKey)) return null;
        List<int[]> corridor = new ArrayList<>();
        for (Long k = goalKey; k != null; k = parent.get(k)) corridor.add(0, Reach.unkey(k));
        Map<Long, int[]> needed = new LinkedHashMap<>();
        for (int i = 1; i < corridor.size(); i++) {
            int[] a = corridor.get(i - 1), b = corridor.get(i);
            for (int[] c : clearFor(g, a, b[0], b[1], b[2], o.maxBlast)) needed.putIfAbsent(Shelter.key(c[0], c[1], c[2]), c);
        }
        return new Path(best.get(goalKey), corridor, new ArrayList<>(needed.values()));
    }

    // what has to go for a mob to step from a to the target: the target's two body blocks, the column it drops down,
    // and the block over its head when it steps up. Null when something there cannot be blasted.
    private static List<int[]> clearFor(Grid g, int[] a, int tx, int ty, int tz, float maxBlast) {
        List<int[]> out = new ArrayList<>(4);
        int top = Math.max(ty + 1, a[1] + 1);
        for (int v = ty; v <= top; v++) if (!need(g, tx, v, tz, v == ty, maxBlast, out)) return null;
        if (ty > a[1] && !need(g, a[0], a[1] + 2, a[2], false, maxBlast, out)) return null;
        return out;
    }

    private static boolean need(Grid g, int x, int y, int z, boolean feet, float maxBlast, List<int[]> out) {
        if (!g.loaded(x, y, z)) return false;
        if (g.water(x, y, z)) return feet;   // wading is fine, a flooded tunnel is not
        if (g.passable(x, y, z)) return true;
        if (g.blast(x, y, z) > maxBlast) return false;
        // opening a block under or beside water floods the tunnel
        if (g.water(x, y + 1, z)) return false;
        for (int[] d : Shelter.DIRS) if (g.water(x + d[0], y, z + d[2])) return false;
        out.add(new int[] { x, y, z });
        return true;
    }

    // Plays the blasts out in order. A blast leaves a crater, so the route is worked out again after each one, from
    // the ground as it is by then. Each creeper walks as far as the last blast opened and goes off by the next block.
    private static void chain(Grid g, int[] spot, Collection<int[]> mobs, Route r, Options o) {
        GridPatch p = new GridPatch(g);
        for (int i = 0; i <= o.maxBlasts; i++) {
            int[] goal = Reach.landing(p, spot);   // a blast can drop the player into the crater
            if (goal == null) { r.why = "the blasts leave the player nowhere a mob could stand"; return; }
            Reach.Walk w = Reach.flood(p, mobs, goal, o.radius, o.maxCells);
            if (w.has(goal)) {
                r.found = true;
                r.why = String.format("%d blasts%s", r.blasts.size(), r.fromCave ? ", from a cave" : "");
                return;
            }
            if (i == o.maxBlasts) break;
            Path now = search(p, goal, w, o);
            if (now == null || now.needed.isEmpty()) { r.why = "the blasts left no way through"; return; }
            int[] stand = closest(w, now.needed.get(0));
            if (stand == null) { r.why = "no spot to stand near the next block"; return; }
            List<int[]> broke = Blast.breaks(p, stand);
            if (Blast.floods(p, broke)) { r.why = "a blast would let water into the route"; return; }
            List<int[]> onRoute = new ArrayList<>();
            for (int[] b : broke) for (int[] n : now.needed) if (b[0] == n[0] && b[1] == n[1] && b[2] == n[2]) onRoute.add(b);
            if (onRoute.isEmpty()) { r.why = "a blast would break nothing on the route"; return; }
            for (int[] b : broke) p.remove(b[0], b[1], b[2]);
            r.blasts.add(new Spot(stand, onRoute));
        }
        r.why = String.format("more than %d blasts needed", o.maxBlasts);
    }

    private static int[] closest(Reach.Walk w, int[] block) {
        int[] best = null;
        double bestD = 12.5;  // a blast does not carry farther than about 3.5 blocks through open air
        for (long k : w.cells()) {
            int[] c = Reach.unkey(k);
            double dx = c[0] - block[0], dy = c[1] - block[1], dz = c[2] - block[2];
            double d = dx * dx + dy * dy + dz * dz;
            if (d < bestD) { bestD = d; best = c; }
        }
        return best;
    }

    private static boolean underRoof(Grid g, int[] c) {
        for (int y = c[1] + 2; y <= c[1] + 24; y++) if (!g.passable(c[0], y, c[2])) return true;
        return false;
    }
}
