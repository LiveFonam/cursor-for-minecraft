package cursor.director;

import java.util.HashMap;
import java.util.Map;

// The shelter and breach analysis on hand built block maps, no server:  node director/scripts/build.js --test
// A flat world like the agents test server: bedrock at -64, dirt -63 and -62, grass -61, the player stands at -60.
public final class ShelterTest {
    static int passed = 0, failed = 0;

    static final class MapGrid implements Grid {
        final Map<Long, String> blocks = new HashMap<>();

        String at(int x, int y, int z) {
            String b = blocks.get(Shelter.key(x, y, z));
            if (b != null) return b;
            if (y <= -64) return "bedrock";
            if (y <= -62) return "dirt";
            if (y == -61) return "grass_block";
            return "air";
        }

        void set(int x, int y, int z, String b) { blocks.put(Shelter.key(x, y, z), b); }

        void fill(int x1, int y1, int z1, int x2, int y2, int z2, String b) {
            for (int x = Math.min(x1, x2); x <= Math.max(x1, x2); x++)
                for (int y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
                    for (int z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) set(x, y, z, b);
        }

        public boolean passable(int x, int y, int z) {
            String b = at(x, y, z);
            return b.equals("air") || b.equals("short_grass") || b.equals("gate_open");
        }

        public boolean floor(int x, int y, int z) {
            String b = at(x, y, z);
            return !passable(x, y, z) && !b.startsWith("gate") && !b.equals("fence");
        }

        public float blast(int x, int y, int z) {
            return switch (at(x, y, z)) {
                case "obsidian" -> 1200f;
                case "cobblestone", "stone" -> 6f;
                case "gate", "gate_open", "planks", "fence" -> 3f;
                case "bedrock" -> 3600000f;
                default -> 0.5f;
            };
        }

        public boolean gate(int x, int y, int z) { return at(x, y, z).startsWith("gate"); }
    }

    // The demo arena: a 7 by 7 inside, cobblestone walls 3 high at x and z = +-4, a fence gate at 0 -60 -4
    static MapGrid arena(String gate) {
        MapGrid g = new MapGrid();
        for (int y = -60; y <= -58; y++) {
            g.fill(-4, y, -4, 4, y, -4, "cobblestone");
            g.fill(-4, y, 4, 4, y, 4, "cobblestone");
            g.fill(-4, y, -4, -4, y, 4, "cobblestone");
            g.fill(4, y, -4, 4, y, 4, "cobblestone");
        }
        g.set(0, -60, -4, gate);
        g.set(0, -59, -4, "air");  // a gate is one block, the gap above it is still too high to jump (1.5 collision)
        g.set(0, -58, -4, "air");
        return g;
    }

    public static void main(String[] args) {
        // gate open: a mob walks in, not a shelter
        Shelter.Result open = Shelter.analyze(arena("gate_open"), 0, -60, 0, 12, 2, 6f);
        check("open gate: not shut in", !open.enclosed);

        // gate closed: shut in, the gate is the first breach, the creeper stands just outside it
        Shelter.Result shut = Shelter.analyze(arena("gate"), 0, -60, 0, 12, 2, 6f);
        check("closed gate: shut in", shut.enclosed);
        check("closed gate: 49 spots inside", shut.cells == 49);
        check("closed gate: the gate is the way in", shut.gates.size() == 1 && Encounter.same(shut.gates.get(0), new int[] { 0, -60, -4 }));
        check("closed gate: breaches found", !shut.breaches.isEmpty());
        Shelter.Breach first = shut.breaches.get(0);
        check("closed gate: the gate goes first", first.kind == Shelter.Kind.GATE && Encounter.same(first.block, new int[] { 0, -60, -4 }));
        check("closed gate: the creeper stands outside it", Encounter.same(first.stand, new int[] { 0, -60, -5 }));
        check("closed gate: walls are breaches too", shut.breaches.stream().anyMatch(b -> b.kind == Shelter.Kind.WALL));

        // the player walls the gate with obsidian and rebuilds the walls in obsidian: no breach at all
        MapGrid ob = arena("gate");
        for (int y = -60; y <= -58; y++) {
            ob.fill(-4, y, -4, 4, y, -4, "obsidian");
            ob.fill(-4, y, 4, 4, y, 4, "obsidian");
            ob.fill(-4, y, -4, -4, y, 4, "obsidian");
            ob.fill(4, y, -4, 4, y, 4, "obsidian");
        }
        Shelter.Result obs = Shelter.analyze(ob, 0, -60, 0, 12, 2, 6f);
        check("obsidian: shut in", obs.enclosed);
        check("obsidian: no breach", obs.breaches.isEmpty());

        // only the gate side in obsidian: the other walls are still breaches, the gate is not
        MapGrid half = arena("gate");
        for (int y = -60; y <= -58; y++) half.fill(-4, y, -4, 4, y, -4, "obsidian");
        Shelter.Result h = Shelter.analyze(half, 0, -60, 0, 12, 2, 6f);
        check("obsidian front: still breaches", !h.breaches.isEmpty());
        check("obsidian front: none through the front", h.breaches.stream().noneMatch(b -> b.block[2] == -4));

        // a wall 3 thick (an extra layer outside and in): too thick, nothing
        MapGrid thick = arena("gate");
        for (int y = -60; y <= -58; y++) {
            for (int t : new int[] { 5, 3 }) {
                thick.fill(-t, y, -t, t, y, -t, "cobblestone");
                thick.fill(-t, y, t, t, y, t, "cobblestone");
                thick.fill(-t, y, -t, -t, y, t, "cobblestone");
                thick.fill(t, y, -t, t, y, t, "cobblestone");
            }
        }
        Shelter.Result th = Shelter.analyze(thick, 0, -60, 0, 12, 2, 6f);
        check("3 thick: shut in", th.enclosed);
        check("3 thick: no breach", th.breaches.isEmpty());
        // 2 thick is still tried (the blast may or may not open it)
        MapGrid two = arena("gate");
        for (int y = -60; y <= -58; y++) {
            two.fill(-5, y, -5, 5, y, -5, "cobblestone");
            two.fill(-5, y, 5, 5, y, 5, "cobblestone");
            two.fill(-5, y, -5, -5, y, 5, "cobblestone");
            two.fill(5, y, -5, 5, y, 5, "cobblestone");
        }
        Shelter.Result tw = Shelter.analyze(two, 0, -60, 0, 12, 2, 6f);
        check("2 thick: breaches", !tw.breaches.isEmpty() && tw.breaches.get(0).thickness == 2);

        // a shallow underground room: 3 by 3 dug out of the dirt (feet -63, head -62), grass roof, shaft closed
        MapGrid cave = new MapGrid();
        cave.fill(-1, -63, -1, 1, -62, 1, "air");
        Shelter.Result c = Shelter.analyze(cave, 0, -63, 0, 12, 2, 6f);
        check("cave: shut in", c.enclosed);
        check("cave: 9 spots", c.cells == 9);
        check("cave: only roof breaches", !c.breaches.isEmpty() && c.breaches.stream().allMatch(b -> b.kind == Shelter.Kind.ROOF));
        check("cave: the creeper stands on the grass above", c.breaches.get(0).stand[1] == -60);
        // under stone 3 deep: no roof breach
        MapGrid deep = new MapGrid();
        deep.fill(-1, -63, -1, 1, -62, 1, "air");
        deep.fill(-3, -61, -3, 3, -59, 3, "stone");
        Shelter.Result dp = Shelter.analyze(deep, 0, -63, 0, 12, 2, 6f);
        check("deep cave: shut in, no breach", dp.enclosed && dp.breaches.isEmpty());

        // open field: not shut in
        check("open field: not shut in", !Shelter.analyze(new MapGrid(), 0, -60, 0, 12, 2, 6f).enclosed);

        // a 1 high step out of a pit is walkable, a 2 high one is not
        MapGrid pit = new MapGrid();
        pit.fill(-2, -61, -2, 2, -61, 2, "air");   // a pit one block deep: step up out of it
        check("1 deep pit: not shut in", !Shelter.analyze(pit, 0, -61, 0, 12, 2, 6f).enclosed);
        MapGrid pit2 = new MapGrid();
        pit2.fill(-2, -62, -2, 2, -61, 2, "air");  // two deep: shut in
        check("2 deep pit: shut in", Shelter.analyze(pit2, 0, -62, 0, 12, 2, 6f).enclosed);

        // the arena preference: its known gate and wall come first
        Settings.Arena a = new Settings.Arena();
        a.wall = new int[] { 4, -60, 0 };
        var pref = a.prefer(shut.breaches);
        check("arena: its wall first when no gate is set", a.isKnown(pref.get(0)) && pref.get(0).block[0] == 4);

        System.out.printf("%d passed, %d failed%n", passed, failed);
        if (failed > 0) System.exit(1);
    }

    static void check(String what, boolean ok) {
        if (ok) passed++; else failed++;
        System.out.println((ok ? "ok   " : "FAIL ") + what);
    }
}
