"""Route questions to the chosen DSH session, using bounded v1 receipt/result requests.

The per-launch key stays in request headers only. Local cancellation stops delivery to the
caller, not the host task: its route lease is drained before the next question can start.
"""
import json
import os
import threading
import time
import uuid
from urllib.parse import urlparse

from . import RouteUnset, VoiceError


class DeliveryError(VoiceError):
    """Safe, structured delivery information; never include transport exception text."""

    def __init__(self, message, delivery="unknown", request_id=None, stage="result"):
        self.delivery = delivery if delivery in ("not-sent", "unknown", "accepted") else "unknown"
        self.accepted = self.delivery == "accepted"
        self.request_id = request_id
        self.stage = stage
        super().__init__(message)


# Match the relay's bounded public-message envelope. Never pass arbitrary payloads
# (reasoning/tool blocks, headers, etc.) to a speech callback.
_MAX_SAFE_INTEGER = (1 << 53) - 1
_MAX_UPDATES = 64
_MAX_UPDATE_TEXT = 4000
_MAX_UPDATE_CHARS = 32000
_MAX_MESSAGE_ID = 120
_MAX_SEEN_IDS = 128


def _integer(value, minimum=0):
    return type(value) is int and minimum <= value <= _MAX_SAFE_INTEGER


def _session_key(value):
    value = str(value or "").strip()
    return value[8:] if value.startswith("session-") else value


class LlmRoute:
    name = "base"

    def ask(self, text):
        raise NotImplementedError


class NoRoute(LlmRoute):
    name = "none"

    def ask(self, text):
        error = RouteUnset()
        error.delivery, error.accepted = "not-sent", False
        error.request_id, error.stage = None, "route"
        raise error


class StubLlm(LlmRoute):
    name = "stub"

    def __init__(self, reply=lambda t: "收到：" + t):
        self.reply = reply
        self.calls = []
        self.images = []

    def ask(self, text, images=None):
        self.calls.append(text)
        self.images.append(list(images or []))
        return self.reply(text)


class SessionRoute(LlmRoute):
    name = "session"

    def __init__(self, session_id, host_base=None, key=None, timeout=1800, post=None, *,
                 clock=None, sleep=None, start_timeout=30, poll_wait=10,
                 poll_timeout=15, poll_retries=3, retry_delay=.25):
        if not _session_key(session_id):
            raise RouteUnset()
        self.session_id = str(session_id).strip()
        self.host_base = (host_base or os.environ.get("PIXELPET_HOST_BASE") or "").rstrip("/")
        self.key = key if key is not None else os.environ.get("PIXELPET_BRIDGE_KEY", "")
        u = urlparse(self.host_base)
        if u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost"):
            raise VoiceError("会话中转只走本机 DSH 地址")
        # timeout remains injectable, but cannot silently exceed the server's hard bound.
        self.timeout = max(.001, min(1800., float(timeout)))
        self._post = post or _post_json
        self._clock = clock or time.monotonic
        self._sleep = sleep or time.sleep
        self._start_timeout = max(.001, min(30., float(start_timeout)))
        self._poll_wait = max(0., min(10., float(poll_wait)))
        self._poll_timeout = max(self._poll_wait + 1., min(30., float(poll_timeout)))
        self._poll_retries = max(0, int(poll_retries))
        self._retry_delay = max(.01, min(5., float(retry_delay)))
        self._ask_lock = threading.Lock()
        self.waiting = 0

    def _upload(self, image_bytes, timeout):
        status, obj = self._post(self.host_base + "/api/shot", bytes(image_bytes),
                                 {"X-PixelPet-Key": self.key, "Content-Type": "application/octet-stream"}, timeout)
        if status != 200 or not isinstance(obj, dict) or not obj.get("ok") or not obj.get("id"):
            raise VoiceError("截图没传上去（HTTP %s）" % status)
        return str(obj["id"])

    def upload(self, image_bytes):
        """One screenshot (PNG/JPEG bytes) -> the host's temporary id for the next ask()."""
        try:
            return self._upload(image_bytes, 60)
        except Exception:
            raise DeliveryError("截图没传上去，问题尚未发送", "not-sent", stage="upload") from None

    def ask(self, text, images=None):
        return self.ask_with_receipt(text, lambda: True, images)

    def ask_if_current(self, text, is_current, images=None):
        return self.ask_with_receipt(text, is_current, images)

    def ask_with_receipt(self, text, is_current, images=None, on_accepted=None):
        return self.ask_with_updates(text, is_current, images, on_accepted)

    def ask_with_updates(self, text, is_current, images=None, on_accepted=None, on_update=None):
        """Serialize whole host leases and deliver validated public-message envelopes.

        on_update is enqueue-only: callers must not perform blocking TTS in it. A
        cancelled caller still drains its lease/cursor and learns acceptance, but
        neither updates nor final text may enter a newer local turn.
        """
        acquired = self._ask_lock.acquire(blocking=False)
        if not acquired:
            self.waiting += 1
            try:
                while is_current():
                    if self._ask_lock.acquire(timeout=.1):
                        acquired = True
                        break
            finally:
                self.waiting -= 1
        if not acquired:
            return ""
        try:
            if not is_current():
                return ""
            return self._ask(text, images, is_current, on_accepted, on_update)
        finally:
            self._ask_lock.release()

    def _snapshot(self, obj, request_id, delivery, known_turn=None):
        """Never trust a 2xx from another request (or a legacy /ask reply).

        sessionId is deliberately NOT compared: with 「跟随外部桥会话」 on, the host may have
        switched the bound session since this request was accepted, and the answer still belongs
        to *this* requestId. The requestId is the only identity that has to match.
        """
        valid = (isinstance(obj, dict) and obj.get("ok") is True
                 and type(obj.get("protocol")) is int and obj["protocol"] == 1
                 and obj.get("requestId") == request_id
                 and isinstance(obj.get("sessionId"), str)
                 and obj.get("state") in ("submitting", "pending", "completed", "failed", "expired")
                 and obj.get("delivery") in ("not-sent", "unknown", "accepted")
                 and obj.get("accepted") is (obj.get("delivery") == "accepted"))
        if valid:
            valid = not (obj["state"] in ("pending", "completed") and not obj["accepted"])
            valid = valid and not (delivery == "accepted" and not obj["accepted"])
            valid = valid and (obj["state"] != "completed" or isinstance(obj.get("reply"), str))
        if valid:
            turn = obj.get("turn")
            valid = turn is None or _integer(turn)
            valid = valid and (known_turn is None or turn == known_turn)
        if not valid:
            raise DeliveryError("会话回执身份或协议不匹配，未重发", delivery, request_id, "protocol")
        updates = obj.get("updates", [])
        update_seq = obj.get("updateSeq")
        valid = (isinstance(updates, list) and len(updates) <= _MAX_UPDATES
                 and ("updateSeq" not in obj or _integer(update_seq)))
        clean_updates, last_seq, chars = [], 0, 0
        if valid:
            for update in updates:
                if not isinstance(update, dict) or not set(update).issubset({"seq", "text", "messageId", "turn"}):
                    valid = False
                    break
                seq, text = update.get("seq"), update.get("text")
                if (not _integer(seq, 1) or seq <= last_seq or not isinstance(text, str)
                        or not text.strip() or len(text) > _MAX_UPDATE_TEXT):
                    valid = False
                    break
                chars += len(text)
                message_id = update.get("messageId")
                if "messageId" in update and (not isinstance(message_id, str) or not message_id.strip()
                        or len(message_id) > _MAX_MESSAGE_ID
                        or any(ord(c) < 32 or ord(c) == 127 for c in message_id)):
                    valid = False
                    break
                update_turn = update.get("turn")
                if (not obj["accepted"] or turn is None
                        or (update_turn is not None and (not _integer(update_turn) or update_turn != turn))):
                    valid = False
                    break
                clean_updates.append(dict(update))
                last_seq = seq
            valid = valid and chars <= _MAX_UPDATE_CHARS
            if updates:
                valid = valid and _integer(update_seq) and update_seq >= last_seq
        if not valid:
            raise DeliveryError("会话增量回执协议不匹配，未重发", delivery, request_id, "protocol")
        # Whitelist fields rather than forwarding raw headers/owner/error strings to the UI.
        safe = {k: obj[k] for k in ("ok", "protocol", "requestId", "sessionId", "state", "delivery",
                                    "accepted", "turn", "reply", "timeoutMs") if k in obj}
        if "updates" in obj:
            safe["updates"] = clean_updates
        if "updateSeq" in obj:
            safe["updateSeq"] = update_seq
        return safe

    def _ask(self, text, images, is_current, on_accepted=None, on_update=None):
        request_id = str(uuid.uuid4())
        deadline = self._clock() + self.timeout
        try:
            return self._exchange(text, images, is_current, on_accepted, request_id, deadline, on_update)
        except DeliveryError as error:
            # Authentication/wrong-job errors must never be retried. If this is an
            # obsolete local call, quarantine its possible host lease until the hard
            # deadline rather than admitting a new question over unfinished work.
            if (error.stage in ("protocol", "result-auth", "result")
                    and error.delivery != "not-sent" and not is_current()):
                remaining = deadline - self._clock()
                if remaining > 0:
                    self._sleep(remaining)
            raise

    def _exchange(self, text, images, is_current, on_accepted, request_id, deadline, on_update=None):
        text = str(text or "").strip()
        headers = {"X-PixelPet-Key": self.key}
        ids = []
        for image in images or []:
            if not is_current():
                return ""
            remaining = deadline - self._clock()
            if remaining <= 0:
                raise DeliveryError("上传超时，问题尚未发送", "not-sent", request_id, "upload")
            try:
                ids.append(self._upload(image, min(60., remaining)))
            except Exception:
                raise DeliveryError("截图没传上去，问题尚未发送", "not-sent", request_id, "upload") from None
        if not text and not ids:
            return ""
        if not is_current():
            return ""
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise DeliveryError("发送前已超时，问题尚未发送", "not-sent", request_id, "start")
        # sessionId 仍照常上报（手动模式靠它选会话）；「跟随外部桥会话」开着时宿主会忽略它，
        # 一律用宿主那边的有效会话。结果只按 requestId 认，所以中途切会话也不会丢这一轮。
        body = {"sessionId": self.session_id, "text": text, "requestId": request_id}
        if ids:
            body["shots"] = ids
        # From this point even a socket exception may mean the host reserved/sent the job.
        # Never POST start again. Recovery is result-only for this exact UUID.
        delivery = "unknown"
        snapshot = None
        try:
            status, obj = self._post(self.host_base + "/api/ask/start", body, headers,
                                     min(self._start_timeout, remaining))
        except Exception:
            status, obj = None, None
        if status is not None:
            if status in (200, 202):
                snapshot = self._snapshot(obj, request_id, delivery)
            elif status in (400, 401, 403, 404, 405, 409, 413, 415, 422, 429):
                raise DeliveryError("会话拒绝了发送（HTTP %s），问题未发送" % status,
                                    "not-sent", request_id, "start")
            elif (isinstance(obj, dict) and obj.get("ok") is False
                  and obj.get("delivery") == "not-sent" and obj.get("accepted") is False):
                raise DeliveryError("会话拒绝了发送，问题未发送", "not-sent", request_id, "start")
            # Other errors are ambiguous; query the same ID instead of submitting again.
        notified = False
        failures = 0
        cursor, known_turn = 0, None
        seen_ids = {}  # insertion ordered, bounded; seq remains the primary dedup cursor
        delivering = True
        while True:
            if not is_current():
                delivering = False  # cancellation is irreversible for this submitted lease
            if snapshot is not None:
                if snapshot.get("turn") is not None:
                    known_turn = snapshot["turn"]
                if snapshot["accepted"]:
                    delivery = "accepted"
                    if not notified:
                        notified = True
                        if on_accepted is not None:
                            try:
                                receipt = dict(snapshot)
                                if "updates" in receipt:
                                    receipt["updates"] = [dict(u) for u in snapshot["updates"]]
                                on_accepted(receipt)
                            except Exception:
                                # UI callbacks cannot abandon an active host lease.
                                pass
                elif snapshot["delivery"] == "unknown":
                    delivery = "unknown"
                # The initial submitting/not-sent snapshot isn't proof of no later send.
                # Only a terminal snapshot may prove the work was definitely not sent.
                if self._clock() >= deadline:
                    raise DeliveryError("等待会话结果超时，未重发", delivery, request_id, "deadline")
                for update in snapshot.get("updates", []):
                    if update["seq"] <= cursor:
                        continue
                    # Advance before calling out: failure, reconnect and cancellation
                    # must never replay a paragraph that might already have been spoken.
                    cursor = update["seq"]
                    message_id = update.get("messageId")
                    duplicate = message_id is not None and message_id in seen_ids
                    if message_id is not None:
                        seen_ids[message_id] = None
                        if len(seen_ids) > _MAX_SEEN_IDS:
                            del seen_ids[next(iter(seen_ids))]
                    if not is_current():
                        delivering = False
                    if delivering and not duplicate and on_update is not None:
                        try:
                            on_update(dict(update))
                        except Exception:
                            # Enqueue/UI failures cannot release an active host lease.
                            pass
                if snapshot["state"] == "completed":
                    return snapshot["reply"].strip() if delivering and is_current() else ""
                if snapshot["state"] in ("failed", "expired"):
                    raise DeliveryError("会话任务未完成，未重发", snapshot["delivery"], request_id,
                                        snapshot["state"])
                snapshot = None
            remaining = deadline - self._clock()
            if remaining <= 0:
                raise DeliveryError("等待会话结果超时，未重发", delivery, request_id, "deadline")
            # Leave a socket margin even when close to the overall deadline.
            wait_ms = int(min(self._poll_wait, max(0., remaining - 1.)) * 1000)
            began = self._clock()
            try:
                status, obj = self._post(self.host_base + "/api/ask/result",
                                         {"sessionId": self.session_id, "requestId": request_id,
                                          "waitMs": wait_ms, "accepted": delivery == "accepted",
                                           "afterSeq": cursor}, headers,
                                         min(self._poll_timeout, remaining))
            except Exception:
                status, obj = None, None
            if status == 200:
                snapshot = self._snapshot(obj, request_id, delivery, known_turn)
                failures = 0
                # Protect against an immediately returning heartbeat/accepted snapshot.
                elapsed = self._clock() - began
                if elapsed < .05 and snapshot["state"] in ("submitting", "pending"):
                    self._sleep(min(.05 - elapsed, max(0., deadline - self._clock())))
                continue
            if status in (401, 403):
                raise DeliveryError("会话鉴权失败，未重发", delivery, request_id, "result-auth")
            if status is not None and status != 404 and not (500 <= status <= 599):
                raise DeliveryError("无法读取会话结果，未重发", delivery, request_id, "result")
            # Socket errors, temporary 5xx and absent-after-uncertain-start are bounded.
            failures += 1
            if failures > self._poll_retries:
                # Temporary transport failures must not orphan an accepted long task.
                # Retry result-only in bounded bursts for the SAME ID, never start again;
                # current and cancelled calls both retain the original hard deadline.
                failures = 0
                self._sleep(min(5., max(0., deadline - self._clock())))
                continue
            self._sleep(min(self._retry_delay, max(0., deadline - self._clock())))


def _post_json(url, body, headers, timeout):
    import urllib.error
    import urllib.request
    data = body if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=bytes(data), headers={"Content-Type": "application/json", **headers},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            return e.code, None


def make_llm(cfg):
    sid = (cfg or {}).get("sessionId")
    if not sid:
        return NoRoute()
    try:
        return SessionRoute(sid)
    except VoiceError:
        return NoRoute()
