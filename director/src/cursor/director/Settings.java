package cursor.director;

import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.FileConfiguration;

import java.util.ArrayList;
import java.util.List;

// config.yml, read once on start and again on /director reload
final class Settings {
    int maxActive = 4;
    int maxReinforcements = 2;
    double recruitRadius = 32;
    int shelterRadius = 12;
    int breachMaxThickness = 2;
    float breachMaxBlast = 6.0f;
    long failCooldownMs = 30000;
    long spawnGapMs = 8000;
    long breachTimeoutMs = 45000;
    double extraFollowRange = 24;
    Arena arena = new Arena();

    static Settings load(FileConfiguration c) {
        Settings s = new Settings();
        s.maxActive = c.getInt("max-active", s.maxActive);
        s.maxReinforcements = c.getInt("max-reinforcements", s.maxReinforcements);
        s.recruitRadius = c.getDouble("recruit-radius", s.recruitRadius);
        s.shelterRadius = c.getInt("shelter-radius", s.shelterRadius);
        s.breachMaxThickness = c.getInt("breach-max-thickness", s.breachMaxThickness);
        s.breachMaxBlast = (float) c.getDouble("breach-max-blast", s.breachMaxBlast);
        s.failCooldownMs = c.getLong("failed-breach-cooldown-seconds", s.failCooldownMs / 1000) * 1000;
        s.spawnGapMs = c.getLong("spawn-gap-seconds", s.spawnGapMs / 1000) * 1000;
        s.breachTimeoutMs = c.getLong("breach-timeout-seconds", s.breachTimeoutMs / 1000) * 1000;
        s.extraFollowRange = c.getDouble("extra-follow-range", s.extraFollowRange);
        ConfigurationSection a = c.getConfigurationSection("arena");
        if (a != null) {
            s.arena.name = a.getString("name", "arena");
            s.arena.gate = xyz(a.getIntegerList("gate"));
            s.arena.wall = xyz(a.getIntegerList("wall"));
        }
        return s;
    }

    private static int[] xyz(List<Integer> l) {
        return l != null && l.size() == 3 ? new int[] { l.get(0), l.get(1), l.get(2) } : null;
    }

    // The demo arena: a gate and a wall block the director knows are meant to be breached. They only get tried first;
    // whether they can be breached is still read from the blocks there now
    static final class Arena {
        String name = null;
        int[] gate;
        int[] wall;

        boolean isKnown(Shelter.Breach b) {
            return (gate != null && Encounter.same(b.block, gate)) || (wall != null && near(b.block, wall));
        }

        private static boolean near(int[] a, int[] b) {
            return Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1 && Math.abs(a[2] - b[2]) <= 1;
        }

        List<Shelter.Breach> prefer(List<Shelter.Breach> all) {
            List<Shelter.Breach> out = new ArrayList<>();
            for (Shelter.Breach b : all) if (gate != null && Encounter.same(b.block, gate)) out.add(b);
            for (Shelter.Breach b : all) if (!out.contains(b) && wall != null && near(b.block, wall)) out.add(b);
            for (Shelter.Breach b : all) if (!out.contains(b)) out.add(b);
            return out;
        }
    }
}
