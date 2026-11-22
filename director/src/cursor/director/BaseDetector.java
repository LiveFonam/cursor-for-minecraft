package cursor.director;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

// What is this place to the player: their base, just a building, a hole they dug to hide in, or open ground? Blocks
// come from the Grid. Everything the blocks cannot say (who placed what, which chests were used, time spent) comes in
// as plain Facts, so the whole decision runs on a test map.
public final class BaseDetector {
    private BaseDetector() {}

    public enum Kind { BASE, BUILDING, HIDEOUT, OPEN }

    public static final class Facts {
        public int[] respawnBed;                                 // the player's respawn bed, or null
        public final List<int[]> usedChests = new ArrayList<>();
        public final List<int[]> usedFurnaces = new ArrayList<>();
        public final Set<Long> placed = new HashSet<>();         // blocks this player placed (Shelter.key)
        public final List<int[]> lights = new ArrayList<>();     // torches and lanterns this player placed
        public double minutesHere;
        public String generatedStructure;                        // the village, temple etc. at this spot, or null

        public void place(int x1, int y1, int z1, int x2, int y2, int z2) {
            for (int x = Math.min(x1, x2); x <= Math.max(x1, x2); x++)
                for (int y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
                    for (int z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) placed.add(Shelter.key(x, y, z));
        }
    }

    public static final class Result {
        public Kind kind;
        public int score;                                  // 0 to 100: how much this looks like the player's home
        public boolean enclosed;
        public boolean generated;                          // a structure the game made, not claimed by the player
        public final List<String> reasons = new ArrayList<>();

        public String summary() { return kind + " " + score + ": " + String.join(", ", reasons); }
    }

    private static final int RADIUS = 12, HOLE_CELLS = 48, BUILT = 12, CLAIM_BLOCKS = 8;

    public static Result classify(Grid world, int[] p, Facts f) {
        Grid g = Snapshot.of(world);
        Result r = new Result();
        Shelter.Result s = Shelter.analyze(doorsShut(g), p[0], p[1], p[2], RADIUS, 2, 6f);
        r.enclosed = s.enclosed;

        boolean bedInside = f.respawnBed != null && s.enclosed && touches(s, f.respawnBed);
        boolean bedNear = f.respawnBed != null && near(f.respawnBed, p);
        int chests = countNear(f.usedChests, p), furnaces = countNear(f.usedFurnaces, p), lights = countNear(f.lights, p);
        int placedNear = 0;
        for (long k : f.placed) if (near(Reach.unkey(k), p)) placedNear++;

        int score = 0;
        if (bedInside) { score += 30; r.reasons.add("respawn bed inside"); }
        else if (bedNear) { score += 12; r.reasons.add("respawn bed nearby"); }
        if (chests > 0) { score += Math.min(16, chests * 8); r.reasons.add(chests + " used chests"); }
        if (furnaces > 0) { score += Math.min(10, furnaces * 5); r.reasons.add(furnaces + " used furnaces"); }
        if (placedNear > 0) { score += Math.min(20, placedNear / 2); r.reasons.add(placedNear + " blocks placed"); }
        if (f.minutesHere >= 2) { score += (int) Math.min(12, f.minutesHere / 2); r.reasons.add((int) f.minutesHere + " minutes here"); }
        if (s.enclosed) { score += 6; r.reasons.add("closed in"); }
        if (s.enclosed && !s.gates.isEmpty()) { score += 3; r.reasons.add("a door or gate"); }
        if (lights >= 2) { score += 3; r.reasons.add(lights + " lights"); }
        if (Moat.ringed(g, p, RADIUS)) { score += 5; r.reasons.add("a moat"); }
        r.score = Math.min(100, score);

        // a looted chest does not make a village house theirs: it takes their bed, real building, or a long stay
        boolean claimed = bedInside || placedNear >= CLAIM_BLOCKS || (chests + furnaces >= 2 && f.minutesHere >= 10);
        if (f.generatedStructure != null && !claimed) {
            r.generated = true;
            r.kind = Kind.OPEN;
            r.score = Math.min(r.score, 15);
            r.reasons.add(0, "generated " + f.generatedStructure + ", not theirs");
            return r;
        }
        if (f.generatedStructure != null) r.reasons.add("claimed a generated " + f.generatedStructure);

        boolean livedIn = bedInside || chests + furnaces >= 2;
        double wallShare = s.enclosed ? placedWallShare(g, s, f) : 0;
        if (r.score >= 50 && livedIn && (s.enclosed || placedNear >= BUILT)) r.kind = Kind.BASE;
        else if (s.enclosed && roof(g, p) >= 1 && wallShare < 0.5 && s.cells <= HOLE_CELLS) {
            r.kind = Kind.HIDEOUT;
            r.reasons.add("dug into natural ground");
        }
        else if (s.enclosed || placedNear >= BUILT) r.kind = Kind.BUILDING;
        else r.kind = Kind.OPEN;
        return r;
    }

    // a base is still a base while its door stands open
    private static Grid doorsShut(Grid g) {
        return new Grid() {
            @Override public boolean passable(int x, int y, int z) { return !g.gate(x, y, z) && g.passable(x, y, z); }
            @Override public boolean floor(int x, int y, int z) { return g.floor(x, y, z); }
            @Override public float blast(int x, int y, int z) { return g.blast(x, y, z); }
            @Override public boolean gate(int x, int y, int z) { return g.gate(x, y, z); }
            @Override public boolean water(int x, int y, int z) { return g.water(x, y, z); }
            @Override public boolean loaded(int x, int y, int z) { return g.loaded(x, y, z); }
        };
    }

    private static boolean near(int[] c, int[] p) {
        return Math.max(Math.abs(c[0] - p[0]), Math.abs(c[2] - p[2])) <= RADIUS && Math.abs(c[1] - p[1]) <= 6;
    }

    private static int countNear(List<int[]> list, int[] p) {
        int n = 0;
        for (int[] c : list) if (near(c, p)) n++;
        return n;
    }

    // the block is in the shut-in space or right beside it
    private static boolean touches(Shelter.Result s, int[] c) {
        for (int dy = -1; dy <= 1; dy++) {
            if (s.contains(c[0], c[1] + dy, c[2])) return true;
            for (int[] d : Shelter.DIRS) if (s.contains(c[0] + d[0], c[1] + dy, c[2] + d[2])) return true;
        }
        return false;
    }

    // of the blocks walling in the space, how many did the player place?
    private static double placedWallShare(Grid g, Shelter.Result s, Facts f) {
        Set<Long> walls = new HashSet<>();
        for (long k : s.inside) {
            int[] c = Reach.unkey(k);
            for (int[] d : Shelter.DIRS)
                for (int dy = 0; dy <= 1; dy++)
                    if (!g.passable(c[0] + d[0], c[1] + dy, c[2] + d[2])) walls.add(Shelter.key(c[0] + d[0], c[1] + dy, c[2] + d[2]));
            if (!g.passable(c[0], c[1] + 2, c[2])) walls.add(Shelter.key(c[0], c[1] + 2, c[2]));
        }
        if (walls.isEmpty()) return 0;
        int mine = 0;
        for (long w : walls) if (f.placed.contains(w)) mine++;
        return (double) mine / walls.size();
    }

    private static int roof(Grid g, int[] p) {
        int n = 0;
        for (int y = p[1] + 2; y <= p[1] + 24; y++) if (!g.passable(p[0], y, p[2])) n++;
        return n;
    }
}
