package cursor.director;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

// Tests each plan on the walking map: after this change, can a zombie reach the player, and how long is the walk?
// Only plans that pass are offered, so a language model picking from the menu cannot pick one that does not work.
public final class PlanScorer {
    private PlanScorer() {}

    public enum Type { BREACH, CHAINED_BREACH, BRIDGE, BRIDGE_BREACH, WAIT }

    public static final class Plan {
        public final Type type;
        public final List<int[]> blasts = new ArrayList<>();  // creeper spots, in order
        public final List<int[]> place = new ArrayList<>();   // blocks to put in, in order

        public Plan(Type type) { this.type = type; }
    }

    public static final class Scored {
        public String id = "";
        public final Plan plan;
        public boolean works;
        public int walk = -1;
        public double cost;
        public String why = "";

        Scored(Plan plan) { this.plan = plan; }

        String line() {
            int[] at = !plan.blasts.isEmpty() ? plan.blasts.get(0) : !plan.place.isEmpty() ? plan.place.get(0) : null;
            return String.format("%s %s blasts=%d place=%d walk=%d%s", id, plan.type.name().toLowerCase(), plan.blasts.size(),
                plan.place.size(), walk, at == null ? "" : String.format(" at=%d,%d,%d", at[0], at[1], at[2]));
        }
    }

    public static final class Ranking {
        public final List<Scored> works = new ArrayList<>();     // best first
        public final List<Scored> rejected = new ArrayList<>();

        // one short line per plan, for a language model to choose from
        public String menu() {
            if (works.isEmpty()) return "P0 wait (no plan reaches the player)";
            StringBuilder b = new StringBuilder();
            for (Scored s : works) b.append(s.line()).append('\n');
            return b.toString().trim();
        }
    }

    private static final int MAX_CELLS = 60000;

    public static Ranking rank(Grid world, int[] player, Collection<int[]> mobs, List<Plan> plans, int radius) {
        Grid g = Snapshot.of(world);
        Ranking out = new Ranking();
        int[] goal = Reach.snap(g, player);
        for (Plan p : plans) {
            Scored s = test(g, goal, mobs, p, radius);
            (s.works ? out.works : out.rejected).add(s);
        }
        out.works.sort(Comparator.<Scored>comparingDouble(s -> s.cost).thenComparingInt(s -> s.plan.type.ordinal()));
        for (int i = 0; i < out.works.size(); i++) out.works.get(i).id = "P" + (i + 1);
        return out;
    }

    private static Scored test(Grid g, int[] goal, Collection<int[]> mobs, Plan plan, int radius) {
        Scored s = new Scored(plan);
        if (goal == null) { s.why = "the player is not standing where a mob could"; return s; }
        GridPatch p = new GridPatch(g);
        for (int[] b : plan.place) {
            if (!g.water(b[0], b[1], b[2]) && !g.passable(b[0], b[1], b[2])) { s.why = "a block is already there"; return s; }
            p.place(b[0], b[1], b[2]);
        }
        for (int[] stand : plan.blasts) {
            Reach.Walk before = Reach.flood(p, mobs, goal, radius, MAX_CELLS);
            if (!before.has(stand)) {
                s.why = String.format("no mob can reach the blast spot %d %d %d", stand[0], stand[1], stand[2]);
                return s;
            }
            List<int[]> broke = Blast.breaks(p, stand);
            if (Blast.floods(p, broke)) { s.why = "a blast would let water in"; return s; }
            for (int[] b : broke) p.remove(b[0], b[1], b[2]);
        }
        int[] end = Reach.landing(p, goal);   // a blast can drop the player into the crater
        if (end == null) { s.why = "the player ends up nowhere a mob could stand"; return s; }
        Reach.Walk after = Reach.flood(p, mobs, end, radius, MAX_CELLS);
        if (!after.has(end)) { s.why = "still no walk to the player"; return s; }
        s.works = true;
        s.walk = after.steps(end);
        s.cost = s.walk + 12.0 * plan.blasts.size() + 4.0 * plan.place.size();
        return s;
    }

    // The plans worth testing here: the shelter's own breaches, the cheapest dug route, a moat bridge, and waiting
    public static List<Plan> candidates(Grid world, int[] player, Collection<int[]> mobs, int radius) {
        Grid g = Snapshot.of(world);
        List<Plan> out = new ArrayList<>();
        Shelter.Result s = Shelter.analyze(g, player[0], player[1], player[2], Math.min(radius, 12), 2, 6f);
        Set<Long> seen = new HashSet<>();
        for (Shelter.Breach b : s.breaches) {
            if (seen.size() >= 3) break;
            if (!seen.add(Shelter.key(b.stand[0], b.stand[1], b.stand[2]))) continue;
            Plan p = new Plan(Type.BREACH);
            p.blasts.add(b.stand);
            out.add(p);
        }
        DugInRoute.Options o = new DugInRoute.Options();
        o.radius = radius;
        DugInRoute.Route r = DugInRoute.plan(g, player, mobs, o);
        if (r.found && !r.blasts.isEmpty()) {
            Plan p = new Plan(r.blasts.size() > 1 ? Type.CHAINED_BREACH : Type.BREACH);
            for (DugInRoute.Spot spot : r.blasts) p.blasts.add(spot.stand);
            out.add(p);
        }
        Moat.Plan m = Moat.analyze(g, player, mobs, radius);
        if (m.reachesPlayer && !m.bridge.isEmpty()) {
            Plan p = new Plan(Type.BRIDGE);
            p.place.addAll(m.bridge);
            out.add(p);
        } else if (m.verdict == Moat.Verdict.WALLED) {
            GridPatch bridged = new GridPatch(g);
            for (int[] b : m.bridge) bridged.place(b[0], b[1], b[2]);
            DugInRoute.Route through = DugInRoute.plan(bridged, player, mobs, o);
            if (through.found && !through.blasts.isEmpty()) {
                Plan p = new Plan(Type.BRIDGE_BREACH);
                p.place.addAll(m.bridge);
                for (DugInRoute.Spot spot : through.blasts) p.blasts.add(spot.stand);
                out.add(p);
            }
        }
        out.add(new Plan(Type.WAIT));
        return out;
    }
}
