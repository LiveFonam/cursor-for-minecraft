package cursor.director;

import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabCompleter;
import org.bukkit.entity.Creeper;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Mob;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.entity.EntityTargetEvent.TargetReason;
import org.bukkit.event.entity.EntityTargetLivingEntityEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

import java.util.List;

// The hostile mob director: an invisible server side helper for the mobs, no entity of its own. One encounter at a
// time against one player. Commands (ops in chat, the server console, or RCON):
//   /director start <player>    take over the hostile mobs near the player and go after them
//   /director stop              end it, the mobs go back to their own AI, no more reinforcements
//   /director status [json]     the target, the tactic and why, the mobs and what each does
//   /director reload            read config.yml again
public final class DirectorPlugin extends JavaPlugin implements Listener, TabCompleter {
    Settings settings;
    Encounter encounter;
    private BukkitTask task;
    private String lastStop = "never started";

    @Override public void onEnable() {
        saveDefaultConfig();
        settings = Settings.load(getConfig());
        getServer().getPluginManager().registerEvents(this, this);
        getCommand("director").setTabCompleter(this);
        getLogger().info(String.format("ready: up to %d mobs, %d reinforcements per encounter, arena %s", settings.maxActive, settings.maxReinforcements, settings.arena.name));
    }

    @Override public void onDisable() {
        stop("the server is stopping");
    }

    boolean isDirectedElsewhere(Mob m) { return false; }  // one encounter at a time

    void start(Player target) {
        if (encounter != null) stop("a new encounter started");
        encounter = new Encounter(this, target);
        task = Bukkit.getScheduler().runTaskTimer(this, () -> { if (encounter != null) encounter.tick(); }, 1L, 10L);
        getLogger().info("encounter started against " + target.getName());
    }

    void stop(String why) {
        if (encounter == null) return;
        Encounter e = encounter;
        encounter = null;  // first: nothing spawns or steers after this line
        e.stopReason = why;
        e.tactic = Encounter.Tactic.STOPPED;
        if (task != null) { task.cancel(); task = null; }
        e.releaseAll();
        lastStop = String.format("stopped against %s: %s (%d reinforcements, last breach: %s)", e.targetName, why, e.reinforcements, e.lastBreach);
        getLogger().info(lastStop);
    }

    @Override public boolean onCommand(CommandSender sender, Command cmd, String label, String[] args) {
        String sub = args.length > 0 ? args[0].toLowerCase() : "status";
        switch (sub) {
            case "start" -> {
                Player p = args.length > 1 ? Bukkit.getPlayerExact(args[1]) : (sender instanceof Player sp ? sp : null);
                if (p == null) { sender.sendMessage("no such player online" + (args.length > 1 ? ": " + args[1] : ", name one")); return true; }
                start(p);
                sender.sendMessage("director: going after " + p.getName());
            }
            case "stop" -> {
                if (encounter == null) { sender.sendMessage("director: nothing running (" + lastStop + ")"); return true; }
                stop("stopped by " + sender.getName());
                sender.sendMessage("director: " + lastStop);
            }
            case "status" -> {
                boolean json = args.length > 1 && args[1].equalsIgnoreCase("json");
                if (encounter == null) sender.sendMessage(json ? "{\"tactic\":\"STOPPED\",\"reason\":" + Encounter.q(lastStop) + "}" : "director: idle, " + lastStop);
                else sender.sendMessage(json ? encounter.statusJson() : "director: " + encounter.status());
            }
            case "debug" -> {
                if (encounter == null) { sender.sendMessage("director: idle"); return true; }
                sender.sendMessage(encounter.debugPaths());
            }
            case "reload" -> {
                reloadConfig();
                settings = Settings.load(getConfig());
                sender.sendMessage("director: config read again");
            }
            default -> sender.sendMessage(ChatColor.YELLOW + "/director start <player> | stop | status [json] | reload");
        }
        return true;
    }

    @Override public List<String> onTabComplete(CommandSender sender, Command cmd, String alias, String[] args) {
        if (args.length == 1) return List.of("start", "stop", "status", "debug", "reload");
        if (args.length == 2 && args[0].equalsIgnoreCase("start")) return Bukkit.getOnlinePlayers().stream().map(Player::getName).toList();
        return List.of();
    }

    // ---------------------------------------------------------------- events

    @EventHandler public void onDeath(PlayerDeathEvent e) {
        if (encounter != null && e.getEntity().getUniqueId().equals(encounter.targetId)) stop(e.getEntity().getName() + " died");
    }

    @EventHandler public void onQuit(PlayerQuitEvent e) {
        if (encounter != null && e.getPlayer().getUniqueId().equals(encounter.targetId)) stop(e.getPlayer().getName() + " disconnected");
    }

    // A held mob does not pick the player as a target by itself (it waits by the entrance or clear of a blast). Hit
    // it and it fights back as usual
    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onTarget(EntityTargetLivingEntityEvent e) {
        if (encounter == null || !(e.getTarget() instanceof Player)) return;
        if (!encounter.holds(e.getEntity().getUniqueId())) return;
        if (e.getReason() == TargetReason.TARGET_ATTACKED_ENTITY || e.getReason() == TargetReason.TARGET_ATTACKED_NEARBY_ENTITY) return;
        e.setCancelled(true);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onExplode(EntityExplodeEvent e) {
        if (encounter != null && e.getEntity() instanceof Creeper c) encounter.onExplode(c, e.blockList().size());
    }

    @EventHandler public void onMobDeath(EntityDeathEvent e) {
        Entity d = e.getEntity();
        if (encounter != null && d instanceof Creeper c) encounter.onCreeperDeath(c, c.getKiller());
    }
}
