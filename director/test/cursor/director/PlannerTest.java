package cursor.director;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

// The base detector, dug-in route, moat analysis and plan scoring on hand built block maps, no server:
// node director/scripts/build.js --test
// The ground: grass at -61, dirt to -63, stone to -99, bedrock at -100. A player on the surface stands at -60.
public final class PlannerTest {
    static int passed = 0, failed = 0;

    static final class World implements Grid {
        final Map<Long, String> blocks = new HashMap<>();

        String at(int x, int y, int z) {
            String b = blocks.get(Shelter.key(x, y, z));
            if (b != null) return b;
            if (y <= -100) return "bedrock";
            if (y <= -64) return "stone";
            if (y <= -62) return "dirt";
            if (y == -61) return "grass_block";
            return "air";
        }

        World fill(int x1, int y1, int z1, int x2, int y2, int z2, String b) {
            for (int x = Math.min(x1, x2); x <= Math.max(x1, x2); x++)
                for (int y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
                    for (int z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) blocks.put(Shelter.key(x, y, z), b);
            return this;
        }

        public boolean passable(int x, int y, int z) {
            String b = at(x, y, z);
            return b.equals("air") || b.equals("water") || b.equals("gate_open");
        }

        public boolean floor(int x, int y, int z) {
            String b = at(x, y, z);
            return !passable(x, y, z) && !b.startsWith("gate");
        }

        public float blast(int x, int y, int z) {
            return switch (at(x, y, z)) {
                case "air" -> 0f;
                case "water" -> 100f;
                case "obsidian" -> 1200f;
                case "bedrock" -> 3600000f;
                case "cobblestone", "stone" -> 6f;
                case "gate", "gate_open", "planks" -> 3f;
                default -> 0.5f;
            };
        }

        public boolean gate(int x, int y, int z) { return at(x, y, z).startsWith("gate"); }

        public boolean water(int x, int y, int z) { return at(x, y, z).equals("water"); }
    }

    static final int[] SURFACE = { 0, -60, 0 };
    static final List<int[]> MOB = List.of(new int[] { 20, -60, 0 });

    // a cobblestone house, 5 by 5 inside, walls 3 high, a roof, and a closed gate
    static World house(String wall) {
        World w = new World();
        w.fill(-3, -60, -3, 3, -58, 3, wall).fill(-2, -60, -2, 2, -58, 2, "air").fill(-3, -57, -3, 3, -57, 3, wall);
        w.fill(0, -60, -3, 0, -59, -3, "air").fill(0, -60, -3, 0, -60, -3, "gate").fill(0, -59, -3, 0, -59, -3, wall);
        return w;
    }

    static void markHouse(BaseDetector.Facts f) {
        f.place(-3, -60, -3, 3, -58, -3); f.place(-3, -60, 3, 3, -58, 3);
        f.place(-3, -60, -3, -3, -58, 3); f.place(3, -60, -3, 3, -58, 3);
        f.place(-3, -57, -3, 3, -57, 3);
    }

    // a sealed room 2 by 2 by 2, `depth` blocks under the grass
    static World buried(int depth) {
        World w = new World();
        int floor = -61 - depth;
        w.fill(0, floor, 0, 1, floor + 1, 1, "air");
        return w;
    }

    // a cave stair from (x, -67, z) up to the surface, going toward +x
    static World stairs(World w, int x, int z) {
        for (int i = 0; i <= 7; i++) w.fill(x + i, -67 + i, z, x + i, -65 + i, z, "air");
        return w;
    }

    // a ring of water `width` wide and `deep` deep around a 5 by 5 island
    static World moat(int width, int deep) {
        World w = new World();
        int r = 2 + width;
        w.fill(-r, -60 - deep, -r, r, -61, r, "water");
        w.fill(-2, -64, -2, 2, -61, 2, "dirt");
        return w;
    }

    // a walled yard on a wide island, with a 2 deep moat 3 wide around the island
    static World walledYard() {
        World w = new World();
        w.fill(-10, -62, -10, 10, -61, 10, "water").fill(-7, -64, -7, 7, -61, 7, "dirt");
        w.fill(-3, -60, -3, 3, -58, 3, "cobblestone").fill(-2, -60, -2, 2, -58, 2, "air");
        return w;
    }

    static boolean hasType(PlanScorer.Ranking r, PlanScorer.Type t) {
        for (PlanScorer.Scored s : r.works) if (s.plan.type == t) return true;
        return false;
    }

    public static void main(String[] args) {
        baseDetector();
        blast();
        dugIn();
        moats();
        scoring();
        System.out.printf("%d passed, %d failed%n", passed, failed);
        if (failed > 0) System.exit(1);
    }

    static void baseDetector() {
        BaseDetector.Result open = BaseDetector.classify(new World(), SURFACE, new BaseDetector.Facts());
        check("base: an empty field is open", open.kind == BaseDetector.Kind.OPEN && open.score < 10);

        BaseDetector.Facts built = new BaseDetector.Facts();
        markHouse(built);
        check("base: a house with nothing in it is a building", BaseDetector.classify(house("cobblestone"), SURFACE, built).kind == BaseDetector.Kind.BUILDING);

        BaseDetector.Facts home = new BaseDetector.Facts();
        markHouse(home);
        home.respawnBed = new int[] { 1, -60, 1 };
        home.usedChests.add(new int[] { -1, -60, 1 });
        home.usedFurnaces.add(new int[] { -2, -60, 1 });
        home.lights.add(new int[] { 1, -58, 1 });
        home.lights.add(new int[] { -1, -58, -1 });
        home.minutesHere = 25;
        BaseDetector.Result base = BaseDetector.classify(house("cobblestone"), SURFACE, home);
        check("base: bed, chest, furnace, time and walls make a base", base.kind == BaseDetector.Kind.BASE && base.score >= 50);
        check("base: the reasons name the bed", base.reasons.contains("respawn bed inside"));

        World doorOpen = house("cobblestone").fill(0, -60, -3, 0, -60, -3, "gate_open");
        BaseDetector.Result open2 = BaseDetector.classify(doorOpen, SURFACE, home);
        check("base: it stays a base with the door open", open2.kind == BaseDetector.Kind.BASE && open2.reasons.contains("respawn bed inside"));

        BaseDetector.Facts village = new BaseDetector.Facts();
        village.generatedStructure = "village";
        BaseDetector.Result v = BaseDetector.classify(house("planks"), SURFACE, village);
        check("base: an untouched village house is ruled out", v.kind == BaseDetector.Kind.OPEN && v.generated && v.score <= 15);

        BaseDetector.Facts looted = new BaseDetector.Facts();
        looted.generatedStructure = "village";
        looted.usedChests.add(new int[] { 1, -60, 1 });
        check("base: looting one chest does not claim it", BaseDetector.classify(house("planks"), SURFACE, looted).generated);

        BaseDetector.Facts claimed = new BaseDetector.Facts();
        claimed.generatedStructure = "village";
        claimed.respawnBed = new int[] { 1, -60, 1 };
        claimed.usedChests.add(new int[] { -1, -60, 1 });
        claimed.usedFurnaces.add(new int[] { -2, -60, 1 });
        claimed.minutesHere = 30;
        BaseDetector.Result c = BaseDetector.classify(house("planks"), SURFACE, claimed);
        check("base: a village house with their bed and use is their base", c.kind == BaseDetector.Kind.BASE && !c.generated);

        World hole = buried(6);
        int[] inHole = { 0, -67, 0 };
        BaseDetector.Facts dug = new BaseDetector.Facts();
        dug.minutesHere = 3;
        check("base: a sealed hole is a hideout", BaseDetector.classify(hole, inHole, dug).kind == BaseDetector.Kind.HIDEOUT);

        BaseDetector.Facts bunker = new BaseDetector.Facts();
        bunker.respawnBed = new int[] { 1, -67, 1 };
        bunker.usedChests.add(new int[] { 0, -67, 1 });
        bunker.usedFurnaces.add(new int[] { 1, -67, 0 });
        bunker.minutesHere = 40;
        check("base: a hole with a bed and stores is a base", BaseDetector.classify(buried(6), inHole, bunker).kind == BaseDetector.Kind.BASE);

        BaseDetector.Facts moated = new BaseDetector.Facts();
        check("base: a ring of water counts as a defense", BaseDetector.classify(moat(3, 2), SURFACE, moated).reasons.contains("a moat"));
    }

    static void blast() {
        World one = new World().fill(1, -60, -3, 1, -58, 3, "cobblestone");
        GridPatch p = new GridPatch(one);
        Blast.apply(p, SURFACE);
        check("blast: breaks a 1 thick cobblestone wall", p.passable(1, -60, 0) && p.passable(1, -59, 0));

        World two = new World().fill(1, -60, -3, 2, -58, 3, "cobblestone");
        GridPatch q = new GridPatch(two);
        Blast.apply(q, SURFACE);
        check("blast: does not get through 2 thick cobblestone", !q.passable(2, -60, 0));

        World obs = new World().fill(1, -60, -3, 1, -58, 3, "obsidian");
        GridPatch o = new GridPatch(obs);
        Blast.apply(o, SURFACE);
        check("blast: leaves obsidian", !o.passable(1, -60, 0));

        World wet = new World().fill(1, -60, 0, 1, -60, 0, "water").fill(2, -60, 0, 2, -60, 0, "planks");
        check("blast: water shields the block behind it", !Blast.hits(wet, SURFACE, 2, -60, 0));
        check("blast: breaking a block beside water counts as a flood", Blast.floods(wet, List.of(new int[] { 2, -60, 0 })));
        check("blast: a block away from water does not", !Blast.floods(wet, List.of(new int[] { 5, -60, 5 })));
    }

    static void dugIn() {
        DugInRoute.Options o = new DugInRoute.Options();
        int[] deep = { 0, -67, 0 };

        DugInRoute.Route r = DugInRoute.plan(buried(6), deep, List.of(new int[] { 6, -60, 0 }), o);
        check("route: reaches a player 6 down", r.found);
        check("route: chains past the 2 block limit", r.blasts.size() >= 2);
        check("route: every blast spot is listed in order", !r.blasts.isEmpty() && r.blasts.get(0).stand[1] >= r.blasts.get(r.blasts.size() - 1).stand[1]);

        World cave = stairs(buried(6).fill(3, -67, -6, 3, -66, 6, "air"), 3, 6);
        DugInRoute.Route viaCave = DugInRoute.plan(cave, deep, List.of(new int[] { 10, -60, 6 }), o);
        check("route: uses a nearby cave", viaCave.found && viaCave.fromCave);
        check("route: the cave saves digging", viaCave.blocks.size() < r.blocks.size());

        World ring = stairs(buried(6), 5, -6);
        ring.fill(5, -67, -6, 5, -66, 6, "air").fill(-4, -67, -6, 5, -66, -6, "air").fill(-4, -67, -6, -4, -66, 6, "air");
        ring.fill(-3, -67, -1, -1, -66, 2, "dirt");
        DugInRoute.Route soft = DugInRoute.plan(ring, deep, List.of(new int[] { 12, -60, -6 }), o);
        double hardest = 0;
        for (int[] b : soft.blocks) hardest = Math.max(hardest, ring.blast(b[0], b[1], b[2]));
        check("route: prefers soft ground", soft.found && !soft.blocks.isEmpty() && hardest <= 0.5);

        World vault = buried(6).fill(-1, -68, -1, 2, -65, 2, "obsidian").fill(0, -67, 0, 1, -66, 1, "air");
        check("route: obsidian all around has no route", !DugInRoute.plan(vault, deep, MOB, o).found);

        DugInRoute.Route free = DugInRoute.plan(new World(), SURFACE, MOB, o);
        check("route: a player in the open needs no blast", free.found && free.blasts.isEmpty());
    }

    static void moats() {
        Moat.Plan real = Moat.analyze(moat(3, 2), SURFACE, MOB, 24);
        check("moat: 2 deep and 3 wide stops zombies", real.verdict == Moat.Verdict.STOPS);
        check("moat: the bridge is 3 blocks", real.bridge.size() == 3);
        int[] first = real.bridge.get(0), last = real.bridge.get(2);
        check("moat: the bridge is listed from the mobs' side", Math.max(Math.abs(first[0]), Math.abs(first[2])) > Math.max(Math.abs(last[0]), Math.abs(last[2])));
        check("moat: the bridge sits on the water", first[1] == -61);

        Moat.Plan shallow = Moat.analyze(moat(3, 1), SURFACE, MOB, 24);
        check("moat: 1 deep does not stop them", shallow.verdict == Moat.Verdict.SHALLOW);

        World gap = moat(3, 2).fill(3, -63, 0, 5, -61, 0, "dirt");
        check("moat: a land bridge means they walk around", Moat.analyze(gap, SURFACE, MOB, 24).verdict == Moat.Verdict.SHORE);

        World narrow = moat(5, 2).fill(5, -63, -1, 7, -61, 1, "dirt");
        Moat.Plan pinch = Moat.analyze(narrow, SURFACE, MOB, 24);
        check("moat: finds the narrowest crossing", pinch.verdict == Moat.Verdict.STOPS && pinch.bridge.size() == 2);

        World walled = moat(3, 2).fill(-2, -60, -2, 2, -58, 2, "cobblestone").fill(-1, -60, -1, 1, -58, 1, "air");
        check("moat: a wall right at the water leaves no land to bridge to", Moat.analyze(walled, SURFACE, MOB, 24).verdict == Moat.Verdict.BLOCKED);

        Moat.Plan yard = Moat.analyze(walledYard(), SURFACE, MOB, 24);
        check("moat: water plus a walled yard is bridged to the land", yard.verdict == Moat.Verdict.WALLED && yard.bridge.size() == 3 && !yard.reachesPlayer);

        World bowl = moat(3, 2);
        bowl.fill(-5, -62, -5, 5, -62, 5, "dirt").fill(-4, -62, -4, 4, -62, 4, "water").fill(-3, -62, -3, 3, -62, 3, "dirt");
        Moat.Plan sloped = Moat.analyze(bowl, SURFACE, MOB, 24);
        check("moat: a sloped bottom does not stop them", sloped.verdict == Moat.Verdict.SHALLOW && sloped.why.contains("bottom"));

        World walls = house("cobblestone");
        check("moat: no water means no moat", Moat.analyze(walls, SURFACE, MOB, 24).verdict == Moat.Verdict.NO_WATER);
    }

    static void scoring() {
        World h = house("cobblestone");
        List<int[]> near = List.of(new int[] { 8, -60, 0 });
        PlanScorer.Ranking gate = PlanScorer.rank(h, SURFACE, near, PlanScorer.candidates(h, SURFACE, near, 24), 24);
        check("score: a house can be breached", hasType(gate, PlanScorer.Type.BREACH));
        check("score: waiting is rejected while shut in", !hasType(gate, PlanScorer.Type.WAIT));
        check("score: the menu is short lines", gate.menu().startsWith("P1 ") && gate.menu().contains("walk="));

        World thick = new World().fill(-5, -60, -5, 5, -57, 5, "cobblestone").fill(-2, -60, -2, 2, -58, 2, "air");
        List<int[]> outside = List.of(new int[] { 10, -60, 0 });
        PlanScorer.Ranking t = PlanScorer.rank(thick, SURFACE, outside, PlanScorer.candidates(thick, SURFACE, outside, 24), 24);
        check("score: a 3 thick wall takes a chained breach", hasType(t, PlanScorer.Type.CHAINED_BREACH));

        World m = moat(3, 2);
        PlanScorer.Ranking mr = PlanScorer.rank(m, SURFACE, MOB, PlanScorer.candidates(m, SURFACE, MOB, 24), 24);
        check("score: a real moat gets a bridge plan", hasType(mr, PlanScorer.Type.BRIDGE));
        check("score: the menu names it", mr.menu().contains("bridge place=") || mr.menu().contains("bridge blasts=0 place=3"));

        World yard = walledYard();
        PlanScorer.Ranking y = PlanScorer.rank(yard, SURFACE, MOB, PlanScorer.candidates(yard, SURFACE, MOB, 24), 24);
        check("score: a moat and a wall get a bridge then a breach", hasType(y, PlanScorer.Type.BRIDGE_BREACH));

        World field = new World();
        PlanScorer.Ranking o = PlanScorer.rank(field, SURFACE, MOB, PlanScorer.candidates(field, SURFACE, MOB, 24), 24);
        check("score: in the open, just walking works", o.works.size() == 1 && o.works.get(0).plan.type == PlanScorer.Type.WAIT && o.works.get(0).walk == 20);

        World vault = new World().fill(-3, -64, -3, 3, -57, 3, "obsidian").fill(-1, -60, -1, 1, -59, 1, "air");
        PlanScorer.Ranking none = PlanScorer.rank(vault, SURFACE, MOB, PlanScorer.candidates(vault, SURFACE, MOB, 24), 24);
        check("score: an obsidian vault offers nothing that works", none.works.isEmpty() && none.menu().startsWith("P0 wait"));

        PlanScorer.Plan bogus = new PlanScorer.Plan(PlanScorer.Type.BREACH);
        bogus.blasts.add(new int[] { 0, -60, 1 });
        PlanScorer.Ranking b = PlanScorer.rank(h, SURFACE, near, List.of(bogus), 24);
        check("score: a blast spot no mob can reach is rejected", b.works.isEmpty() && b.rejected.get(0).why.contains("blast spot"));
    }

    static void check(String what, boolean ok) {
        if (ok) passed++; else failed++;
        System.out.println((ok ? "ok   " : "FAIL ") + what);
    }
}
