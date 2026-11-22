package cursor.director;

import java.util.ArrayList;
import java.util.List;

// What one creeper blast would break, worked out the way the game does it: rays leave the creeper's feet and lose
// strength through every block. The game gives each ray a random strength between 2.1 and 3.9. Many rays hit each
// nearby block, so this uses one steady value in the upper part of that range. It is an estimate of the real blast.
public final class Blast {
    private Blast() {}

    public static final double POWER = 3.45;
    private static final double STEP = 0.3, FADE = 0.225, FEET = 0.0625;
    private static final int RANGE = 4, REACH2 = 21;   // a ray dies after about 4.6 blocks of open air
    private static final double NEAR = 0.15, FAR = 0.85;
    // the middle of a block and its eight corners, just inside
    private static final double[][] AIM = {
        { 0.5, 0.5, 0.5 },
        { NEAR, NEAR, NEAR }, { NEAR, NEAR, FAR }, { NEAR, FAR, NEAR }, { NEAR, FAR, FAR },
        { FAR, NEAR, NEAR }, { FAR, NEAR, FAR }, { FAR, FAR, NEAR }, { FAR, FAR, FAR },
    };

    private static double resistance(Grid g, int x, int y, int z) {
        if (g.water(x, y, z)) return 100;
        if (g.passable(x, y, z)) return -1;  // nothing in the way
        return g.blast(x, y, z);
    }

    // does a ray from the creeper's feet get into this block with strength left?
    static boolean hits(Grid g, int[] feet, int bx, int by, int bz) {
        double cx = feet[0] + 0.5, cy = feet[1] + FEET, cz = feet[2] + 0.5;
        for (double[] aim : AIM) {
            double dx = bx + aim[0] - cx, dy = by + aim[1] - cy, dz = bz + aim[2] - cz;
            double len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (len < 1e-6) continue;
            dx *= STEP / len; dy *= STEP / len; dz *= STEP / len;
            double f = POWER, px = cx, py = cy, pz = cz;
            for (int i = 0; i < 24 && f > 0; i++) {
                int x = (int) Math.floor(px), y = (int) Math.floor(py), z = (int) Math.floor(pz);
                double r = resistance(g, x, y, z);
                if (r >= 0) f -= (r + 0.3) * 0.3;
                if (f > 0 && x == bx && y == by && z == bz) return true;
                f -= FADE;
                px += dx; py += dy; pz += dz;
            }
        }
        return false;
    }

    // the solid blocks one blast at these feet would break
    public static List<int[]> breaks(Grid g, int[] feet) {
        List<int[]> out = new ArrayList<>();
        for (int x = feet[0] - RANGE; x <= feet[0] + RANGE; x++)
            for (int y = feet[1] - RANGE; y <= feet[1] + RANGE; y++)
                for (int z = feet[2] - RANGE; z <= feet[2] + RANGE; z++) {
                    int ox = x - feet[0], oy = y - feet[1], oz = z - feet[2];
                    if (ox * ox + oy * oy + oz * oz > REACH2) continue;
                    if (!g.loaded(x, y, z) || g.passable(x, y, z) || g.water(x, y, z)) continue;
                    if (hits(g, feet, x, y, z)) out.add(new int[] { x, y, z });
                }
        return out;
    }

    // Would breaking these let water pour in? Flowing water is not modeled, so a plan that does this is not trusted.
    public static boolean floods(Grid g, List<int[]> broke) {
        for (int[] c : broke) {
            if (g.water(c[0], c[1] + 1, c[2])) return true;
            for (int[] d : Shelter.DIRS) if (g.water(c[0] + d[0], c[1], c[2] + d[2])) return true;
        }
        return false;
    }

    // all of a blast's rays run against the world as it was before it
    public static List<int[]> apply(GridPatch p, int[] feet) {
        List<int[]> broke = breaks(p, feet);
        for (int[] b : broke) p.remove(b[0], b[1], b[2]);
        return broke;
    }
}
