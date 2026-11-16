"""Pure animation / state helpers (no Tk). Shared by the player and the tests.

Priority used by choose_state:
    drag > walk (commanded motion) > transient (click / poke) > voice > manual > pose > mood > idle
Pose and mood are (state, until|None) leases that only ever replace a plain idle,
except that they may briefly cover the voice "listening" state.
"""
import math
import time

GAZE_STEPS = 16
GAZE_STEP_DEG = 360 / GAZE_STEPS

# Voice bridge state -> preferred pet states (first one the character defines wins).
VOICE_STATES = {
    "idle": (),
    "listening": ("attentive", "idle"),
    "hearing": ("listening", "attentive", "idle"),    # continuous listening picked up speech
    "thinking": ("running",),
    "speaking": ("speaking", "idle"),
}


def resolve(states, value, aliases=None):
    """Alias -> canonical id; None if the character does not have that state."""
    if not isinstance(value, str):
        return None
    value = (aliases or {}).get(value, value)
    return value if value in states else None


def gaze_index(dx, dy, deadzone=18, radius=480, previous=None):
    """Pointer offset from the pet's eyes -> one of 16 gaze directions (0 = up, clockwise) or None."""
    distance = math.hypot(dx, dy)
    if distance <= deadzone or distance > radius:
        return None
    degrees = math.degrees(math.atan2(dx, -dy)) % 360
    if previous is not None:
        delta = abs((degrees - previous * GAZE_STEP_DEG + 180) % 360 - 180)
        if delta <= GAZE_STEP_DEG * 0.6333:          # hysteresis so the eyes do not flicker on a boundary
            return previous
    return int(math.floor((degrees + GAZE_STEP_DEG / 2) / GAZE_STEP_DEG)) % GAZE_STEPS


def degrees_to_gaze(deg):
    return int(round((deg % 360) / GAZE_STEP_DEG)) % GAZE_STEPS


def _live(lease, now):
    return bool(lease) and (lease[1] is None or lease[1] > now)


def voice_state(states, voice):
    for sid in VOICE_STATES.get(voice, ()):
        if sid in states:
            return sid
    return None


def choose_state(states, *, drag=None, walk=None, transient=None, voice=None, manual="idle",
                 pose=None, mood=None, now=None):
    """Pick the state to show. `states` is the character's state dict (or any container of ids)."""
    now = time.time() if now is None else now
    if drag and drag in states:
        return drag
    if walk and walk in states:
        return walk
    if transient and transient[1] > now and transient[0] in states:
        return transient[0]
    pose_l = pose[0] if _live(pose, now) and pose[0] in states else None
    mood_l = mood[0] if _live(mood, now) and mood[0] in states else None
    leased = pose_l or mood_l
    v = voice_state(states, voice) if voice and voice != "idle" else None
    if v and v != "idle":
        # A mood the session just picked is short-lived and deliberate: it shows over thinking and
        # speaking alike. A held pose (lie, sit...) keeps through listening/speaking, but thinking
        # still shows the working face so the user sees it is busy.
        if voice == "thinking":
            return mood_l or v
        return leased or v
    if manual and manual != "idle" and manual in states:
        return manual
    if leased:
        return leased
    return "idle"


def mood_state(moods, tag):
    """Mood tag (from the character's `moods` map) -> state id, or None."""
    if not isinstance(tag, str) or not isinstance(moods, dict):
        return None
    return moods.get(tag)


def mood_lease(moods, payload, seen_seq=None, now=None, cap=30.0):
    """{tag, seq, until} -> (state, until, seq) or None. Ignores unknown tags, stale or already-seen leases."""
    now = time.time() if now is None else now
    if not isinstance(payload, dict):
        return None
    state = mood_state(moods, payload.get("tag"))
    seq, until = payload.get("seq"), payload.get("until")
    if not state or seq == seen_seq or not isinstance(until, (int, float)) or isinstance(until, bool):
        return None
    if not math.isfinite(until) or until <= now:
        return None
    return state, min(until, now + cap), seq


class FrameClock:
    """Per-frame durations -> current frame index. Restarts on state change; `reduced` pins frame 0."""

    def __init__(self):
        self.state = None
        self.index = 0
        self.deadline = 0.0

    def tick(self, state, durations, now, reduced=False, loop=True):
        if state != self.state:
            self.state = state
            self.index = 0
            self.deadline = now + durations[0] / 1000
        if reduced:
            self.index = 0
            self.deadline = now + durations[0] / 1000
            return 0
        for _ in range(32):
            if now < self.deadline:
                break
            if not loop and self.index == len(durations) - 1:
                self.deadline = now + durations[self.index] / 1000
                break
            self.index = (self.index + 1) % len(durations)
            self.deadline += durations[self.index] / 1000
        if now >= self.deadline:
            self.deadline = now + durations[self.index] / 1000
        return self.index

def music_state(states, desired, music, *, voice="idle", protected=False, paused_seconds=0):
    """Only substitute the ordinary idle and speaking animations."""
    if protected or music == "off" or (music == "paused" and paused_seconds >= 600):
        return desired
    if voice == "speaking" and desired in ("speaking", "idle"):
        role = "music-speaking"
    elif desired == "idle" and voice == "idle":
        role = "music-listening" if music == "playing" else "music-idle"
    else:
        return desired
    return next((sid for sid, state in states.items()
                 if state.get("role") == role and (state.get("requires") or {}).get("feature") == "listen"), desired)
