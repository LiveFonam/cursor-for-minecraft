"""The 1v1 fighter with a live screen of its named neurons.

    python neuron_policy.py --run <campaign folder>

It speaks the same JSON lines as agents_policy.py and picks actions with the same Player. The screen is a page at
http://127.0.0.1:<DEMO_NEURONS_PORT> (default 8770, 0 for none), on this machine only.

The fight never waits for the screen. Each decision leaves one copy of its numbers in a slot, and a background thread
works out the frame from the newest copy, only while a page is open. A failure in the screen never reaches the fight.
"""

import hashlib
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT))

from agents_policy import DEFAULT_RUN, INPUT_LIMIT, Player, reply  # noqa: E402

HOST = "127.0.0.1"
DEFAULT_PORT = 8770
FRAME_SECONDS = 0.09
MAX_PAGES = 6
LINES_PER_GAP = 34
STREAM_TYPE = "text/" + "event-stream"

HEADS = [
    ("Move", ["none", "forward", "back"]),
    ("Strafe", ["none", "left", "right"]),
    ("Sprint", ["off", "on"]),
    ("Jump", ["off", "on"]),
    ("Turn", [f"step {i}" for i in range(18)]),
    ("Look", [f"step {i}" for i in range(15)]),
    ("Attack", ["none", "click", "double click"]),
    ("Use", ["off", "on"]),
    ("Weapon", ["keep", "axe", "sword", "crossbow", "bow"]),
    ("Sneak", ["off", "on"]),
    ("Aim lock", ["off", "on"]),
]
GROUPS = [
    ("My body", [1, 2, 3, 4, 5, 6, 7, 11]),
    ("My health and hits", [0, 10, 61, 62, 65, 66]),
    ("My weapon and charge", [12, 13, 14, 15, 16, 17, 18]),
    ("My shield", [19, 20, 21, 63]),
    ("My crossbow", [22, 23, 24, 25, 75, 76, 77, 78, 79, 80]),
    ("Enemy position", [26, 27, 28, 29, 30, 31, 32, 33, 34]),
    ("Crosshair and sight", [35, 36, 37, 38]),
    ("Enemy movement", [39, 40, 41, 42, 43, 44]),
    ("Enemy health and swing", [45, 46, 47, 64]),
    ("Enemy weapon", [48, 49, 50, 51, 57, 58, 59]),
    ("Enemy shield and facing", [52, 53, 54, 55, 56]),
    ("Arrows", list(range(81, 96))),
    ("Blocks and walls", list(range(96, 130))),
    ("Last action and time", [67, 68, 69, 70, 71, 72, 73, 74]),
]


def load_names(policy_bytes, path=HERE / "neurons.json"):
    """The named neurons, or None when the names were measured on a different network."""
    try:
        doc = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None
    if doc.get("policy_sha256") != hashlib.sha256(policy_bytes).hexdigest():
        return None
    return doc


def fallback_names(layers):
    """Without matching names the screen shows the strongest wired neurons by number, and says so."""
    out = []
    for at, (weight, _) in enumerate(layers[:-1]):
        strength = np.abs(layers[at + 1][0]).sum(axis=0)
        for j in np.argsort(-strength)[:32]:
            out.append({"layer": at + 1, "id": int(j), "name": f"Neuron {int(j)}", "scale": 1.0})
    return {"neurons": out, "unnamed": True}


class Screen:
    """Turns the newest decision into a frame for the open pages."""

    def __init__(self, policy, names):
        self.layers = policy.layers
        self.offsets = np.asarray(policy.offsets)
        self.sizes = np.asarray(policy.nvec)
        doc = names or fallback_names(policy.layers)
        self.neurons = doc["neurons"]
        self.named = not doc.get("unnamed")
        self.at = {
            layer: np.array([n["id"] for n in self.neurons if n["layer"] == layer], dtype=np.int64) for layer in (1, 2)
        }
        self.scale = {
            layer: np.array([n.get("scale", 1.0) for n in self.neurons if n["layer"] == layer], dtype=np.float32)
            for layer in (1, 2)
        }
        self.group_slots = [np.array(slots, dtype=np.int64) for _, slots in GROUPS]
        self.lock = threading.Lock()
        self.latest = None
        self.seq = 0
        self.frame = None
        self.frame_seq = 0
        self.pages = 0
        self.enemy_hp = None
        self.changed = threading.Condition()

    def meta(self):
        return {
            "named": self.named,
            "groups": [name for name, _ in GROUPS],
            "heads": [{"name": name, "choices": choices} for name, choices in HEADS],
            "neurons": {str(layer): [n for n in self.neurons if n["layer"] == layer] for layer in (1, 2)},
        }

    def publish(self, obs, mask, action):
        """Called by the fight. It only stores references to arrays nothing else will change."""
        if self.pages <= 0:
            return
        with self.lock:
            self.latest = (obs, mask, action)
            self.seq += 1

    def compute(self, obs, mask, action):
        (w0, b0), (w1, b1), (w2, _) = self.layers
        h1 = np.maximum(w0 @ obs + b0, 0.0)
        h2 = np.maximum(w1 @ h1 + b1, 0.0)
        at1, at2 = self.at[1], self.at[2]
        groups = np.array([float((w0[at1][:, s] * obs[s]).sum(axis=1).__abs__().mean()) for s in self.group_slots])
        top = max(float(groups.max()), 1e-6)

        into1 = np.stack([(w0[at1][:, s] * obs[s]).sum(axis=1) for s in self.group_slots])
        into2 = w1[at2][:, at1] * h1[at1]
        pushes, picks = [], []
        for head, (start, size) in enumerate(zip(self.offsets, self.sizes)):
            legal = mask[start : start + size]
            pick = int(action[head])
            picks.append(pick)
            part = w2[start : start + size][:, at2]
            mean = part[legal].mean(axis=0) if legal.any() else 0.0
            pushes.append((part[pick] - mean) * h2[at2])
        out = np.stack(pushes)

        lines = []
        for gap, matrix in enumerate((into1, into2.T, out.T)):
            flat = matrix.reshape(-1)
            if not len(flat):
                continue
            count = min(LINES_PER_GAP, len(flat))
            best = np.argpartition(-np.abs(flat), count - 1)[:count]
            peak = max(float(np.abs(flat[best]).max()), 1e-6)
            for k in best:
                value = float(flat[k])
                if value == 0.0:
                    continue
                a, b = np.unravel_index(int(k), matrix.shape)
                lines.append([gap, int(a), int(b), round(value / peak, 3)])
        return {
            "n1": np.round(np.minimum(h1[at1] / self.scale[1], 1.0), 3).tolist(),
            "n2": np.round(np.minimum(h2[at2] / self.scale[2], 1.0), 3).tolist(),
            "raw1": np.round(h1[at1], 2).tolist(),
            "raw2": np.round(h2[at2], 2).tolist(),
            "groups": np.round(groups / top, 3).tolist(),
            "picks": picks,
            "lines": lines,
            "me": round(float(obs[0]) * 20, 1),
            "enemy": self.enemy_hp,
        }

    def run(self):
        seen = 0
        while True:
            time.sleep(FRAME_SECONDS)
            if self.pages <= 0:
                continue
            with self.lock:
                seq, item = self.seq, self.latest
            if item is None or seq == seen:
                continue
            seen = seq
            try:
                frame = json.dumps(self.compute(*item), separators=(",", ":"))
            except Exception as err:  # the screen can fail, the fight goes on
                print(f"[neurons] {err}", file=sys.stderr)
                continue
            with self.changed:
                self.frame = frame
                self.frame_seq += 1
                self.changed.notify_all()


def make_handler(screen):
    page = (HERE / "neuron_screen.html").read_bytes()
    meta = json.dumps(screen.meta()).encode()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send_bytes(self, body, kind):
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            route = self.path.split("?")[0]
            if route == "/":
                self.send_bytes(page, "text/html; charset=utf-8")
            elif route == "/meta":
                self.send_bytes(meta, "application/json")
            elif route == "/stream":
                self.stream()
            else:
                self.send_error(404)

        def stream(self):
            if screen.pages >= MAX_PAGES:
                self.send_error(503)
                return
            screen.pages += 1
            try:
                self.send_response(200)
                self.send_header("Content-Type", STREAM_TYPE)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                seen = 0
                while True:
                    with screen.changed:
                        if screen.frame_seq == seen:
                            screen.changed.wait(5)
                        seen, frame = screen.frame_seq, screen.frame
                    self.wfile.write(f"data: {frame}\n\n".encode() if frame else b": waiting\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionError, OSError):
                pass
            finally:
                screen.pages -= 1

    return Handler


def start_screen(policy, policy_bytes):
    """Starts the page. Returns the screen, or None when it is off or its port is taken."""
    port = int(os.environ.get("DEMO_NEURONS_PORT", DEFAULT_PORT))
    if port == 0:
        return None
    try:
        screen = Screen(policy, load_names(policy_bytes))
        server = ThreadingHTTPServer((HOST, port), make_handler(screen))
    except Exception as err:
        print(f"[neurons] no screen: {err}", file=sys.stderr)
        return None
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=screen.run, daemon=True).start()
    state = "named" if screen.named else "unnamed, the names belong to a different network"
    print(f"[neurons] http://{HOST}:{port} ({state})", file=sys.stderr)
    return screen


def policy_file(run):
    run = Path(run)
    for candidate in (run / "fighter" / "policy.npz", run / "policy.npz"):
        if candidate.exists():
            return candidate
    raise FileNotFoundError(f"no policy.npz in {run}")


def main():
    args = sys.argv[1:]
    run = Path(args[args.index("--run") + 1] if "--run" in args else DEFAULT_RUN)
    if not run.is_absolute():
        run = ROOT / run
    if "PYTHONPATH" not in os.environ:
        sys.path.insert(0, str(ROOT / "fighter" / "src"))
    try:
        player = Player(run)
        screen = start_screen(player.policy, policy_file(run).read_bytes())
    except Exception as err:  # reported to the bridge, which calls the fight off
        reply({"error": f"could not load {run}: {err}"})
        return
    reply({"hello": {"name": player.name, "rate": player.rate, "kind": False, "fair": True, "experts": player.versions}})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = {}
        try:
            msg = json.loads(line)
            if "hp" in msg:  # the opponent's real health from the server, for the page only
                if screen is not None:
                    screen.enemy_hp = float(msg["hp"])
                continue
            action = player.act([msg["obs"]], [msg["mask"]])[0]
            answer = [int(x) for x in action]
            reply({"id": msg["id"], "action": answer})
            if screen is not None:
                obs = np.clip(np.asarray(msg["obs"], dtype=np.float32), -INPUT_LIMIT, INPUT_LIMIT)
                screen.publish(obs, np.asarray(msg["mask"], dtype=bool), answer)
        except Exception as err:
            reply({"id": msg.get("id"), "error": str(err)})


if __name__ == "__main__":
    main()
