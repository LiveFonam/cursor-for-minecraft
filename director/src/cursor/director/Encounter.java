package cursor.director;

import com.destroystokyo.paper.entity.Pathfinder.PathResult;
import org.bukkit.Bukkit;
import org.bukkit.FluidCollisionMode;
import org.bukkit.GameRule;
import org.bukkit.Location;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.attribute.Attribute;
import org.bukkit.attribute.AttributeInstance;
import org.bukkit.attribute.AttributeModifier;
import org.bukkit.entity.AbstractSkeleton;
import org.bukkit.entity.Creeper;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Mob;
import org.bukkit.entity.Player;
import org.bukkit.entity.Zombie;
import org.bukkit.event.entity.CreatureSpawnEvent.SpawnReason;
import org.bukkit.util.RayTraceResult;
import org.bukkit.util.Vector;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;

// One encounter: the mobs the director has taken over, against one player. Ticked every half second by the plugin.
//
// Tactics, picked again on every tick from the world as it is:
//   ASSAULT   a zombie's own pathfinder finds a route to the player: every directed mob attacks the normal way
//   APPROACH  the player is in the open but no route yet (far, water, a pillar): mobs close in on their own AI
//   BREACH    the player is shut in: one creeper walks to the weakest wall, gate or roof it can reach, the others hold
//             8 blocks back, the creeper lights its normal fuse at the wall, the server does the explosion. After the
//             blast it looks again: a route means ASSAULT, none means a failed breach and a cooldown
//   WAIT      shut in and no breach (too thick, too strong, no creeper can reach, cooldown): mobs wait by the way in
// Skeletons shoot whenever they can see the player and are not standing by a fuse.
//
// It never touches health, never removes a block itself, never moves a mob except by its own pathfinder, and
// changes no setting. A breach only works where the game's own creeper explosion breaks the blocks.
final class Encounter {
    enum Tactic { STARTING, ASSAULT, APPROACH, BREACH, WAIT, STOPPED }
    enum Role { MELEE, CREEPER, RANGED }

    static final String TAG = "director";

    static final class Directed {
        final UUID id;
        final Role role;
        final boolean spawned;
        boolean hold;          // kept from targeting the player (back from a blast, waiting by the entrance)
        String state = "joined";

        Directed(UUID id, Role role, boolean spawned) { this.id = id; this.role = role; this.spawned = spawned; }
    }

    final DirectorPlugin plugin;
    final UUID targetId;
    final String targetName;
    final Map<UUID, Directed> mobs = new LinkedHashMap<>();
    final Random random = new Random();
    final long startedAt = System.currentTimeMillis();

    Tactic tactic = Tactic.STARTING;
    String reason = "starting";
    int reinforcements = 0;
    long lastSpawnAt = 0;
    long cooldownUntil = 0;
    String lastBreach = "none yet";
    String stopReason = null;
    int ticks = 0;

    // the breach in progress
    Shelter.Breach breach;
    UUID breachCreeper;
    long breachStartedAt;
    boolean ignited;
    long ignitedAt;
    boolean exploded;
    int attempts = 0;

    Shelter.Result shelter;
    long shelterAt = 0;
    Location lastOutside;      // where the player last stood in the open
    int[] lastEntrance;        // the gate or door they shut, as a block

    Encounter(DirectorPlugin plugin, Player target) {
        this.plugin = plugin;
        this.targetId = target.getUniqueId();
        this.targetName = target.getName();
        this.lastOutside = target.getLocation();
    }

    private Settings cfg() { return plugin.settings; }

    // ---------------------------------------------------------------- the tick

    void tick() {
        ticks++;
        Player p = Bukkit.getPlayer(targetId);
        if (p == null || !p.isOnline()) { plugin.stop(targetName + " disconnected"); return; }
        if (p.isDead() || p.getHealth() <= 0) { plugin.stop(targetName + " died"); return; }
        prune(p);
        recruit(p);
        if (breach != null) {
            runBreach(p);
        } else {
            decide(p);
        }
        if (stopReason == null) apply(p);
    }

    // Mobs that died, despawned, changed world or wandered off leave the encounter
    private void prune(Player p) {
        Iterator<Directed> it = mobs.values().iterator();
        while (it.hasNext()) {
            Directed d = it.next();
            Entity e = Bukkit.getEntity(d.id);
            if (e == null || e.isDead() || !e.isValid() || e.getWorld() != p.getWorld() || e.getLocation().distance(p.getLocation()) > 80) {
                if (e instanceof Mob m && e.isValid()) release(m);
                if (d.id.equals(breachCreeper) && breach != null && !exploded) {
                    it.remove();
                    failBreach("the creeper was gone before it went off");
                    continue;
                }
                it.remove();
            }
        }
    }

    // Hostile mobs already near the player join first, up to the cap
    private void recruit(Player p) {
        if (mobs.size() >= cfg().maxActive) return;
        double r = cfg().recruitRadius;
        List<Mob> near = new ArrayList<>();
        for (Entity e : p.getWorld().getNearbyEntities(p.getLocation(), r, r / 2, r)) {
            if (!(e instanceof Mob m) || !e.isValid() || mobs.containsKey(e.getUniqueId())) continue;
            if (roleOf(m) == null || plugin.isDirectedElsewhere(m)) continue;
            near.add(m);
        }
        near.sort((a, b) -> Double.compare(a.getLocation().distanceSquared(p.getLocation()), b.getLocation().distanceSquared(p.getLocation())));
        for (Mob m : near) {
            if (mobs.size() >= cfg().maxActive) break;
            take(m, false);
        }
    }

    static Role roleOf(Entity e) {
        if (e instanceof Creeper) return Role.CREEPER;
        if (e instanceof Zombie) return Role.MELEE;  // zombies, husks, drowned, zombie villagers
        if (e instanceof AbstractSkeleton) return Role.RANGED;
        return null;
    }

    private void take(Mob m, boolean spawned) {
        Directed d = new Directed(m.getUniqueId(), roleOf(m), spawned);
        mobs.put(m.getUniqueId(), d);
        m.addScoreboardTag(TAG);
        // a longer path range, so a creeper 20 blocks out can plan its walk to the wall (creepers see 16 by default)
        AttributeInstance follow = m.getAttribute(Attribute.FOLLOW_RANGE);
        NamespacedKey key = new NamespacedKey(plugin, "follow");
        if (follow != null && follow.getModifier(key) == null) follow.addModifier(new AttributeModifier(key, cfg().extraFollowRange, AttributeModifier.Operation.ADD_NUMBER));
        plugin.getLogger().info(String.format("%s %s joins (%s)", name(m), spawned ? "spawned as reinforcement" : "recruited", d.role));
    }

    void release(Mob m) {
        m.removeScoreboardTag(TAG);
        AttributeInstance follow = m.getAttribute(Attribute.FOLLOW_RANGE);
        if (follow != null) follow.removeModifier(new NamespacedKey(plugin, "follow"));
    }

    void releaseAll() {
        for (Directed d : mobs.values()) {
            if (Bukkit.getEntity(d.id) instanceof Mob m) {
                // a held mob gets its own AI back as it was; nothing is reset on the others
                release(m);
            }
        }
        mobs.clear();
    }

    // ---------------------------------------------------------------- choosing a tactic

    private void decide(Player p) {
        String route = meleeRoute(p);
        Shelter.Result s = shelterOf(p, false);
        if (!s.enclosed) lastOutside = p.getLocation();
        if (melee().isEmpty() && creepers().isEmpty() && spawnIfAllowed(p, Zombie.class, s)) return;
        if (route != null) {
            set(Tactic.ASSAULT, route);
            return;
        }
        if (!s.enclosed) {
            set(Tactic.APPROACH, String.format("%s is in the open (%s) but no zombie has a route yet, closing in", targetName, s.why));
            return;
        }
        if (!s.gates.isEmpty()) lastEntrance = s.gates.get(0);
        String shut = String.format("%s is shut in (%d spots%s), no zombie route", targetName, s.cells, gateNote(p.getWorld(), s));
        long now = System.currentTimeMillis();
        if (now < cooldownUntil) {
            set(Tactic.WAIT, String.format("%s; waiting by the way in, %d s cooldown after: %s", shut, (cooldownUntil - now + 999) / 1000, lastBreach));
            return;
        }
        if (!Boolean.TRUE.equals(p.getWorld().getGameRuleValue(GameRule.MOB_GRIEFING))) {
            set(Tactic.WAIT, shut + "; mob_griefing is off on this world, so a creeper blast breaks no blocks");
            return;
        }
        if (s.breaches.isEmpty()) {
            set(Tactic.WAIT, shut + "; " + s.why);
            return;
        }
        Creeper c = freeCreeper(p);
        if (c == null) {
            if (spawnIfAllowed(p, Creeper.class, s)) { set(Tactic.WAIT, shut + "; no creeper near, calling one in"); return; }
            set(Tactic.WAIT, shut + "; no creeper to blast with" + (reinforcements >= cfg().maxReinforcements ? " and no reinforcements left" : ""));
            return;
        }
        List<Shelter.Breach> order = plugin.settings.arena.prefer(s.breaches);
        Shelter.Breach pick = null;
        PathResult path = null;
        int tried = 0;
        for (Shelter.Breach b : order) {
            if (tried++ >= 8) break;
            Location stand = loc(p.getWorld(), b.stand);
            if (c.getPathfinder().hasPath()) c.getPathfinder().stopPathfinding();
            PathResult pr = c.getPathfinder().findPath(stand);
            if (pr != null && pr.canReachFinalPoint() && pr.getFinalPoint() != null && pr.getFinalPoint().distance(stand) < 1.6) { pick = b; path = pr; break; }
        }
        if (pick == null) {
            set(Tactic.WAIT, String.format("%s; the creeper can reach none of the %d places to blast (best: %s)", shut, s.breaches.size(), order.get(0)));
            return;
        }
        startBreach(p, c, pick, path, shut);
    }

    private String gateNote(World w, Shelter.Result s) {
        if (s.gates.isEmpty()) return "";
        int[] g = s.gates.get(0);
        return ", gate at " + g[0] + " " + g[1] + " " + g[2] + " closed";
    }

    // A zombie whose own pathfinder reaches the player, as text for the status, or null
    private String meleeRoute(Player p) {
        for (Mob m : melee()) {
            PathResult pr = routeTo(m, p.getLocation());
            if (pr != null) return String.format("%s has an open route to %s (%d steps)", name(m), targetName, pr.getPoints().size());
        }
        return null;
    }

    // A path for this mob that ends within 2.5 blocks of the spot, or null. The path it is already walking counts.
    // Otherwise it plans a fresh one, after clearing the mob's navigation: on Paper 1.21.11 findPath also sets the
    // navigation's remembered target, and a mob still on an old path (a wander) then gets that old path back from its
    // own attack AI and walks off (seen live: a zombie hit the player twice, then left through the gate for good)
    static PathResult routeTo(Mob m, Location to) {
        PathResult cur = m.getPathfinder().getCurrentPath();
        if (endsNear(cur, to)) return cur;
        if (m.getPathfinder().hasPath()) m.getPathfinder().stopPathfinding();
        PathResult pr = m.getPathfinder().findPath(to);
        return endsNear(pr, to) ? pr : null;
    }

    static boolean endsNear(PathResult pr, Location to) {
        return pr != null && pr.canReachFinalPoint() && pr.getFinalPoint() != null && pr.getFinalPoint().distance(to) < 2.5;
    }

    Shelter.Result shelterOf(Player p, boolean fresh) {
        long now = System.currentTimeMillis();
        if (fresh || shelter == null || now - shelterAt > 1000) {
            Location l = p.getLocation();
            shelter = Shelter.analyze(new WorldGrid(p.getWorld()), l.getBlockX(), l.getBlockY(), l.getBlockZ(),
                cfg().shelterRadius, cfg().breachMaxThickness, cfg().breachMaxBlast);
            shelterAt = now;
        }
        return shelter;
    }

    // ---------------------------------------------------------------- the breach

    private void startBreach(Player p, Creeper c, Shelter.Breach b, PathResult path, String shut) {
        breach = b;
        breachCreeper = c.getUniqueId();
        breachStartedAt = System.currentTimeMillis();
        ignited = false;
        exploded = false;
        attempts++;
        mobs.get(c.getUniqueId()).state = "walking to the breach";
        c.setTarget(null);
        c.getPathfinder().moveTo(path, 1.0);
        String known = plugin.settings.arena.isKnown(b) ? " (the arena's known breach)" : "";
        set(Tactic.BREACH, String.format("%s; weakest way in it can reach: %s%s, %s walks there (%d steps), the others hold 8 blocks back",
            shut, b, known, name(c), path.getPoints().size()));
    }

    private void runBreach(Player p) {
        if (exploded) return;  // waiting for the look after the blast
        Entity e = Bukkit.getEntity(breachCreeper);
        if (!(e instanceof Creeper c) || c.isDead()) { failBreach("the creeper died before it went off"); return; }
        long now = System.currentTimeMillis();
        // the player opened up meanwhile: no need to blast
        if (ticks % 4 == 0) {
            String route = meleeRoute(p);
            if (route != null && !ignited) {
                breach = null; breachCreeper = null;
                set(Tactic.ASSAULT, route + " (the way opened before the blast, creeper joins the attack)");
                return;
            }
            // the wall changed (obsidian put in, gate opened, more wall built): look again
            Shelter.Result s = shelterOf(p, true);
            if (!ignited && (!s.enclosed || s.breaches.stream().noneMatch(x -> same(x.stand, breach.stand)))) {
                breach = null; breachCreeper = null;
                lastBreach = "called off, the walls changed";
                plugin.getLogger().info("breach called off: the walls changed");
                return;
            }
        }
        Location stand = loc(p.getWorld(), breach.stand);
        Location at = c.getLocation();
        double flat = Math.hypot(at.getX() - stand.getX(), at.getZ() - stand.getZ());
        if (!ignited) {
            if (c.getTarget() != null) c.setTarget(null);
            if (flat <= 1.25 && Math.abs(at.getY() - stand.getY()) < 1.0) {
                c.getPathfinder().stopPathfinding();
                c.ignite();  // the normal fuse: it swells and hisses for 1.5 s, the player can still run or kill it
                ignited = true;
                ignitedAt = now;
                mobs.get(c.getUniqueId()).state = "fuse lit at the breach";
                reason = String.format("%s lit its fuse at the %s; the others hold back", name(c), breach);
                plugin.getLogger().info(String.format("%s lit its fuse at %s", name(c), breach));
                return;
            }
            if (ticks % 2 == 0) c.getPathfinder().moveTo(stand, 1.0);
            if (now - breachStartedAt > cfg().breachTimeoutMs) failBreach(String.format("%s could not get to the breach in %d s", name(c), cfg().breachTimeoutMs / 1000));
        } else if (now - ignitedAt > 6000) {
            failBreach("the fuse went out without a blast");
        }
    }

    // The game exploded our creeper (blocks are already decided by the server). Look again a moment later
    void onExplode(Creeper c, int blocks) {
        if (!c.getUniqueId().equals(breachCreeper)) return;
        exploded = true;
        mobs.remove(c.getUniqueId());
        String where = breach.toString();
        plugin.getLogger().info(String.format("blast at %s broke %d blocks", where, blocks));
        Bukkit.getScheduler().runTaskLater(plugin, () -> afterBlast(where, blocks), 10L);
    }

    private void afterBlast(String where, int blocks) {
        if (stopReason != null) return;
        Player p = Bukkit.getPlayer(targetId);
        if (p == null) return;
        Shelter.Result s = shelterOf(p, true);
        String route = meleeRoute(p);
        breach = null;
        breachCreeper = null;
        exploded = false;
        ignited = false;
        if (route != null || !s.enclosed) {
            lastBreach = String.format("opened: the blast at %s broke %d blocks", where, blocks);
            String why = route != null ? route : String.format("%s is no longer shut in (%s)", targetName, s.why);
            set(Tactic.ASSAULT, String.format("the blast at %s broke %d blocks and opened a way in; %s", where, blocks, why));
        } else {
            failBreach(String.format("the blast at %s broke %d blocks but left no way in (%s)", where, blocks, s.why));
        }
    }

    // A directed creeper died without exploding (the player killed it)
    void onCreeperDeath(Creeper c, Player killer) {
        if (!c.getUniqueId().equals(breachCreeper) || exploded) return;
        mobs.remove(c.getUniqueId());
        failBreach("the creeper was killed before it went off" + (killer != null ? " by " + killer.getName() : ""));
    }

    private void failBreach(String why) {
        lastBreach = "failed: " + why;
        breach = null;
        breachCreeper = null;
        ignited = false;
        exploded = false;
        cooldownUntil = System.currentTimeMillis() + cfg().failCooldownMs;
        set(Tactic.WAIT, String.format("breach failed: %s; next try in %d s", why, cfg().failCooldownMs / 1000));
    }

    // ---------------------------------------------------------------- what the mobs do

    private void apply(Player p) {
        World w = p.getWorld();
        Location hold = holdPoint(p);
        for (Directed d : mobs.values()) {
            if (!(Bukkit.getEntity(d.id) instanceof Mob m)) continue;
            if (d.id.equals(breachCreeper)) { d.hold = true; continue; }  // runBreach steers it
            boolean attack = tactic == Tactic.ASSAULT || tactic == Tactic.APPROACH;
            // ranged support: a skeleton that sees the player and stands clear of the fuse shoots
            if (!attack && d.role == Role.RANGED && m.hasLineOfSight(p) && m.getLocation().distance(p.getLocation()) <= 16
                && (breach == null || m.getLocation().distance(loc(w, breach.stand)) >= 8)) {
                d.hold = false;
                d.state = "shooting";
                if (m.getTarget() != p) m.setTarget(p);
                continue;
            }
            if (attack) {
                d.hold = false;
                d.state = tactic == Tactic.ASSAULT ? "attacking" : "closing in";
                if (m.getTarget() != p) m.setTarget(p);
                continue;
            }
            // hold back: by the entrance, or clear of the blast
            if (!d.hold) { d.hold = true; m.setTarget(null); }
            if (hold == null) { d.state = "waiting"; continue; }
            d.state = breach != null ? "holding back from the blast" : "waiting by the way in";
            if (m.getLocation().distance(hold) > 3 && ticks % 2 == 0) m.getPathfinder().moveTo(hold, 1.0);
        }
    }

    // Where the others wait: 8 blocks out from a breach, or just outside the gate the player shut (else where the player
    // was last seen in the open). Always a spot a mob can stand on
    private Location holdPoint(Player p) {
        World w = p.getWorld();
        WorldGrid g = new WorldGrid(w);
        int[] base;
        int[] dir;
        if (breach != null) {
            base = breach.stand;
            dir = breach.out[1] != 0 ? new int[] { 1, 0, 0 } : breach.out;
            int[] want = { base[0] + dir[0] * 8, base[1], base[2] + dir[2] * 8 };
            return nearestStand(g, w, want, shelter);
        }
        if (lastEntrance != null && shelter != null) {
            for (Shelter.Breach b : shelter.breaches) {
                if (b.kind == Shelter.Kind.GATE && same(b.block, lastEntrance)) {
                    int[] want = { b.stand[0] + b.out[0] * 3, b.stand[1], b.stand[2] + b.out[2] * 3 };
                    return nearestStand(g, w, want, shelter);
                }
            }
        }
        if (lastOutside != null && lastOutside.getWorld() == w) {
            return nearestStand(g, w, new int[] { lastOutside.getBlockX(), lastOutside.getBlockY(), lastOutside.getBlockZ() }, shelter);
        }
        return null;
    }

    private static Location nearestStand(WorldGrid g, World w, int[] want, Shelter.Result s) {
        for (int r = 0; r <= 4; r++) {
            for (int dx = -r; dx <= r; dx++) for (int dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) != r) continue;
                for (int dy : new int[] { 0, 1, -1, 2, -2 }) {
                    int x = want[0] + dx, y = want[1] + dy, z = want[2] + dz;
                    if (Shelter.standable(g, x, y, z) && (s == null || !s.contains(x, y, z))) return new Location(w, x + 0.5, y, z + 0.5);
                }
            }
        }
        return null;
    }

    // ---------------------------------------------------------------- reinforcements

    // Spawns one mob if the encounter may (cap, per encounter limit, a gap between spawns): out of the player's sight,
    // outside their shelter, on ground a mob can stand on, 14 to 24 blocks away
    private <T extends Mob> boolean spawnIfAllowed(Player p, Class<T> type, Shelter.Result s) {
        long now = System.currentTimeMillis();
        if (reinforcements >= cfg().maxReinforcements || mobs.size() >= cfg().maxActive || now - lastSpawnAt < cfg().spawnGapMs) return false;
        if (plugin.encounter != this || stopReason != null) return false;
        World w = p.getWorld();
        WorldGrid g = new WorldGrid(w);
        Location c = p.getLocation();
        for (int i = 0; i < 80; i++) {
            double a = random.nextDouble() * Math.PI * 2;
            double d = 14 + random.nextDouble() * 10;
            int x = (int) Math.floor(c.getX() + Math.cos(a) * d), z = (int) Math.floor(c.getZ() + Math.sin(a) * d);
            for (int y = c.getBlockY() + 6; y >= c.getBlockY() - 8; y--) {
                if (!Shelter.standable(g, x, y, z)) continue;
                if (s != null && s.contains(x, y, z)) break;
                Location spot = new Location(w, x + 0.5, y, z + 0.5);
                if (inView(p, spot)) break;
                T mob = w.spawn(spot, type, SpawnReason.REINFORCEMENTS, true, m -> {});
                reinforcements++;
                lastSpawnAt = now;
                take(mob, true);
                plugin.getLogger().info(String.format("reinforcement %d/%d: %s at %d %d %d, out of %s's sight", reinforcements, cfg().maxReinforcements, name(mob), x, y, z, targetName));
                return true;
            }
        }
        return false;
    }

    // In the player's field of view (within 70 degrees of where they look) with nothing in between
    static boolean inView(Player p, Location spot) {
        Location eye = p.getEyeLocation();
        Vector to = spot.clone().add(0, 1, 0).toVector().subtract(eye.toVector());
        double len = to.length();
        if (len < 0.1) return true;
        if (eye.getDirection().angle(to) > Math.toRadians(70)) return false;
        RayTraceResult hit = p.getWorld().rayTraceBlocks(eye, to.clone().normalize(), len, FluidCollisionMode.NEVER, true);
        return hit == null;
    }

    // ---------------------------------------------------------------- helpers

    private List<Mob> melee() {
        List<Mob> out = new ArrayList<>();
        for (Directed d : mobs.values()) if (d.role == Role.MELEE && Bukkit.getEntity(d.id) instanceof Mob m && m.isValid()) out.add(m);
        return out;
    }

    private List<Creeper> creepers() {
        List<Creeper> out = new ArrayList<>();
        for (Directed d : mobs.values()) if (d.role == Role.CREEPER && Bukkit.getEntity(d.id) instanceof Creeper c && c.isValid()) out.add(c);
        return out;
    }

    private Creeper freeCreeper(Player p) {
        Creeper best = null;
        for (Creeper c : creepers()) {
            if (c.isIgnited()) continue;
            if (best == null || c.getLocation().distanceSquared(p.getLocation()) < best.getLocation().distanceSquared(p.getLocation())) best = c;
        }
        return best;
    }

    private void set(Tactic t, String why) {
        if (t != tactic) plugin.getLogger().info(String.format("tactic %s: %s", t, why));
        tactic = t;
        reason = why;
    }

    boolean holds(UUID id) {
        Directed d = mobs.get(id);
        return d != null && d.hold;
    }

    static Location loc(World w, int[] b) { return new Location(w, b[0] + 0.5, b[1], b[2] + 0.5); }

    static boolean same(int[] a, int[] b) { return a[0] == b[0] && a[1] == b[1] && a[2] == b[2]; }

    static String name(Entity e) {
        return e.getType().name().toLowerCase() + "#" + e.getEntityId();
    }

    // ---------------------------------------------------------------- status

    // Each mob's own path to the target as the server plans it right now (/director debug)
    String debugPaths() {
        Player p = Bukkit.getPlayer(targetId);
        if (p == null) return "no target";
        StringBuilder sb = new StringBuilder();
        for (Directed d : mobs.values()) {
            if (!(Bukkit.getEntity(d.id) instanceof Mob m)) continue;
            Location l = m.getLocation();
            sb.append(String.format("%s at %.1f %.1f %.1f: ", name(m), l.getX(), l.getY(), l.getZ()));
            PathResult pr = m.getPathfinder().getCurrentPath();
            sb.append(pr != null ? "walking " : "planned ");
            if (pr == null) pr = m.getPathfinder().findPath(p);
            if (pr == null) { sb.append("no path | "); continue; }
            Location f = pr.getFinalPoint();
            sb.append(String.format("%d points, reach %s, ends %s", pr.getPoints().size(), pr.canReachFinalPoint(), f == null ? "-" : String.format("%.0f %.0f %.0f", f.getX(), f.getY(), f.getZ())));
            List<Location> pts = pr.getPoints();
            for (int i = 0; i < pts.size(); i += Math.max(1, pts.size() / 6)) sb.append(String.format(" (%.0f %.0f)", pts.get(i).getX(), pts.get(i).getZ()));
            sb.append(" | ");
        }
        return sb.toString();
    }

    String status() {
        Player p = Bukkit.getPlayer(targetId);
        StringBuilder sb = new StringBuilder();
        sb.append("target ").append(targetName);
        if (p != null) sb.append(String.format(" (health %.0f)", p.getHealth()));
        sb.append(" | tactic ").append(tactic).append(": ").append(reason);
        sb.append(" | mobs ").append(mobs.size()).append('/').append(cfg().maxActive).append(':');
        for (Directed d : mobs.values()) {
            Entity e = Bukkit.getEntity(d.id);
            if (e == null) continue;
            sb.append(' ').append(name(e)).append(' ').append(d.state);
            if (p != null) sb.append(String.format(" %.0fm", e.getLocation().distance(p.getLocation())));
            sb.append(',');
        }
        if (sb.charAt(sb.length() - 1) == ',') sb.setLength(sb.length() - 1);
        sb.append(" | reinforcements ").append(reinforcements).append('/').append(cfg().maxReinforcements);
        long cd = cooldownUntil - System.currentTimeMillis();
        if (cd > 0) sb.append(" | cooldown ").append((cd + 999) / 1000).append(" s");
        sb.append(" | last breach: ").append(lastBreach);
        return sb.toString();
    }

    // The same as one JSON line, for the live test
    String statusJson() {
        Player p = Bukkit.getPlayer(targetId);
        StringBuilder sb = new StringBuilder("{");
        sb.append("\"target\":").append(q(targetName));
        sb.append(",\"health\":").append(p != null ? String.format("%.1f", p.getHealth()) : "null");
        sb.append(",\"tactic\":").append(q(tactic.name())).append(",\"reason\":").append(q(reason));
        sb.append(",\"ignited\":").append(ignited).append(",\"breach\":").append(breach != null ? q(breach.toString()) : "null");
        sb.append(",\"lastBreach\":").append(q(lastBreach)).append(",\"attempts\":").append(attempts);
        sb.append(",\"reinforcements\":").append(reinforcements);
        sb.append(",\"cooldown\":").append(Math.max(0, (cooldownUntil - System.currentTimeMillis() + 999) / 1000));
        sb.append(",\"mobs\":[");
        boolean first = true;
        for (Directed d : mobs.values()) {
            Entity e = Bukkit.getEntity(d.id);
            if (e == null) continue;
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"id\":").append(e.getEntityId()).append(",\"type\":").append(q(e.getType().name().toLowerCase()))
                .append(",\"role\":").append(q(d.role.name())).append(",\"state\":").append(q(d.state))
                .append(",\"spawned\":").append(d.spawned)
                .append(",\"dist\":").append(p != null ? String.format("%.1f", e.getLocation().distance(p.getLocation())) : "null").append('}');
        }
        sb.append("]}");
        return sb.toString();
    }

    static String q(String s) {
        return '"' + s.replace("\\", "\\\\").replace("\"", "\\\"") + '"';
    }
}
