r"""Frozen v1 route contract. Pure fake POST/clock only: no service, model, or TTS calls.

Run from the plugin directory:
  python -B -m unittest discover -s tests -p test_long_route.py -v      (runtime/ is put on sys.path by the test itself)
"""
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'runtime'))  # runnable alone, not only after other tests
import threading
import time
import unittest
from unittest.mock import patch
from uuid import UUID

from pixelpet.voice import RouteUnset, VoiceError
from pixelpet.voice.llm import DeliveryError, NoRoute, SessionRoute, make_llm


BASE = "http://127.0.0.1:3080/dsh-pixel-pet"
SECRET = "synthetic-launch-key-do-not-echo"


class Clock:
    def __init__(self):
        self.now = 0.
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def snapshot(body, state="pending", delivery="accepted", **extra):
    data = dict(ok=True, protocol=1, requestId=body["requestId"], sessionId="s",
                state=state, delivery=delivery, accepted=delivery == "accepted",
                turn=1 if delivery == "accepted" else None, timeoutMs=1800000)
    if state == "completed":
        data["reply"] = "最终结果"
    data.update(extra)
    return data


class LongRoute(unittest.TestCase):
    def setUp(self):
        # Any accidental real transport is an immediate test failure.
        self.network = patch("pixelpet.voice.llm._post_json", side_effect=AssertionError("network forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def route(self, post, clock=None, **limits):
        clock = clock or Clock()
        return SessionRoute("session-s", host_base=BASE, key=SECRET, post=post,
                            clock=clock, sleep=clock.sleep, **limits)

    def test_six_minute_virtual_task_has_receipt_before_final_no_three_minute_loss(self):
        clock = Clock()
        calls, receipts = [], []
        def post(url, body, headers, timeout):
            calls.append((url, dict(body), timeout, clock()))
            self.assertEqual(headers, {"X-PixelPet-Key": SECRET})
            if url.endswith("/start"):
                return 202, snapshot(body, "submitting", "not-sent")
            clock.now += body["waitMs"] / 1000
            return 200, snapshot(body, "completed" if clock() >= 360 else "pending")
        route = self.route(post, clock)
        reply = route.ask_with_receipt("合成六分钟任务", lambda: True,
                                       on_accepted=lambda r: receipts.append((clock(), r)))
        self.assertEqual(reply, "最终结果")
        self.assertEqual(clock(), 360)
        self.assertEqual(len(receipts), 1)
        self.assertLess(receipts[0][0], 180)
        self.assertTrue(receipts[0][1]["accepted"])
        starts = [c for c in calls if c[0].endswith("/start")]
        self.assertEqual(len(starts), 1)
        request_id = starts[0][1]["requestId"]
        self.assertEqual(str(UUID(request_id)), request_id)
        self.assertTrue(all(c[1]["requestId"] == request_id for c in calls))
        self.assertTrue(all(c[2] <= 30 for c in calls))
        self.assertTrue(all(c[1].get("waitMs", 0) <= 10000 for c in calls))
        self.assertTrue(all(c[2] >= c[1]["waitMs"] / 1000 + 1 for c in calls[1:]))
        self.assertEqual(route.timeout, 1800)

    def test_immediate_completed_receipt_once_and_safe_fields(self):
        events = []
        def post(url, body, headers, timeout):
            self.assertTrue(url.endswith("/start"))
            return 202, snapshot(body, "completed", owner=SECRET, headers={"key": SECRET})
        route = self.route(post)
        reply = route.ask_with_receipt("问题", lambda: True, on_accepted=lambda r: events.append(r))
        events.append(reply)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[1], "最终结果")
        self.assertNotIn(SECRET, repr(events))

    def test_start_socket_lost_recovers_only_same_id_never_reposts(self):
        calls, receipts = [], []
        def post(url, body, headers, timeout):
            calls.append((url, dict(body)))
            if url.endswith("/start"):
                raise OSError(SECRET)
            return 200, snapshot(body, "completed")
        self.assertEqual(self.route(post).ask_with_receipt("问题", lambda: True,
                         on_accepted=receipts.append), "最终结果")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][1]["requestId"], calls[1][1]["requestId"])
        self.assertEqual(len(receipts), 1)

    def test_uncertain_start_absent_or_disconnected_stays_unknown_and_bounded(self):
        for result in (404, None, 503):
            with self.subTest(result=result):
                calls = []
                def post(url, body, headers, timeout):
                    calls.append(url)
                    if url.endswith("/start") or result is None:
                        raise OSError(SECRET)
                    return result, {"ok": False, "message": SECRET}
                with self.assertRaises(DeliveryError) as caught:
                    self.route(post, timeout=12, poll_retries=2).ask("问题")
                e = caught.exception
                self.assertEqual(e.delivery, "unknown")
                self.assertFalse(e.accepted)
                self.assertEqual(e.stage, "deadline")
                self.assertEqual(sum(u.endswith("/start") for u in calls), 1)
                self.assertGreaterEqual(len(calls), 4)
                self.assertLess(len(calls), 100)  # bounded bursts keep polling, never resubmit
                self.assertNotIn(SECRET, str(e))
                self.assertIsInstance(e, VoiceError)

    def test_start_explicit_rejection_is_not_sent_and_never_polled(self):
        for code in (400, 401, 403, 404, 405, 409, 413, 422, 429, 503):
            with self.subTest(code=code):
                calls = []
                def post(url, body, headers, timeout):
                    calls.append(url)
                    return code, {"ok": False, "delivery": "not-sent", "accepted": False, "message": SECRET}
                with self.assertRaises(DeliveryError) as caught:
                    self.route(post).ask("问题")
                self.assertEqual(caught.exception.delivery, "not-sent")
                self.assertEqual(caught.exception.stage, "start")
                self.assertEqual(len(calls), 1)
                self.assertNotIn(SECRET, str(caught.exception))

    def test_ambiguous_start_500_recovers_same_id(self):
        calls = []
        def post(url, body, headers, timeout):
            calls.append(url)
            if url.endswith("/start"):
                return 500, {"ok": False, "message": SECRET}
            return 200, snapshot(body, "completed")
        self.assertEqual(self.route(post).ask("问题"), "最终结果")
        self.assertEqual(len(calls), 2)

    def test_poll_transport_hiccups_retry_without_duplicate_receipt(self):
        calls, receipts = [], []
        def post(url, body, headers, timeout):
            calls.append(url)
            if len(calls) in (2, 4):
                raise OSError(SECRET)
            return (202 if len(calls) == 1 else 200), snapshot(body,
                "completed" if len(calls) == 5 else "pending")
        self.assertEqual(self.route(post, poll_retries=1).ask_with_receipt("问题", lambda: True,
                         on_accepted=receipts.append), "最终结果")
        self.assertEqual(len(receipts), 1)
        self.assertEqual(sum(c.endswith("/start") for c in calls), 1)

    def test_auth_failure_never_retried_preserves_accepted(self):
        for accepted in (False, True):
            with self.subTest(accepted=accepted):
                calls = []
                def post(url, body, headers, timeout):
                    calls.append(url)
                    if len(calls) == 1:
                        return 202, snapshot(body, "pending" if accepted else "submitting",
                                             "accepted" if accepted else "not-sent")
                    return 401, {"message": SECRET}
                with self.assertRaises(DeliveryError) as caught:
                    self.route(post).ask("问题")
                self.assertEqual(caught.exception.delivery, "accepted" if accepted else "unknown")
                self.assertEqual(caught.exception.stage, "result-auth")
                self.assertEqual(len(calls), 2)
                self.assertNotIn(SECRET, str(caught.exception))

    def test_wrong_job_protocol_or_delivery_never_accepted_or_retried(self):
        # sessionId 不再参与身份判断（2026-11-15「跟随外部桥会话」：宿主可能在这一轮还没答完时切会话，
        # 结果仍属于这个 requestId；见 test_follow_route.py）。类型不对照样算协议错误。
        changes = ({"requestId": "other"}, {"sessionId": 42}, {"protocol": 2},
                   {"protocol": True}, {"accepted": 1}, {"accepted": False},
                   {"state": "completed", "delivery": "not-sent", "accepted": False},
                   {"state": "completed", "reply": None}, {"ok": 1}, {"state": "garbage"})
        for where in ("start", "result"):
            for change in changes:
                with self.subTest(where=where, change=change):
                    calls, receipts = [], []
                    def post(url, body, headers, timeout):
                        calls.append(url)
                        if where == "start" or len(calls) == 2:
                            return 202 if len(calls) == 1 else 200, snapshot(body, **change)
                        return 202, snapshot(body, "submitting", "not-sent")
                    with self.assertRaises(DeliveryError) as caught:
                        self.route(post).ask_with_receipt("问题", lambda: True, on_accepted=receipts.append)
                    self.assertEqual(caught.exception.stage, "protocol")
                    self.assertEqual(caught.exception.delivery, "unknown")
                    self.assertEqual(receipts, [])
                    self.assertEqual(len(calls), 1 if where == "start" else 2)

    def test_legacy_success_body_is_not_silent_fallback(self):
        calls = []
        def post(url, body, headers, timeout):
            calls.append(url)
            return 200, {"ok": True, "reply": "不应采用"}
        with self.assertRaises(DeliveryError) as caught:
            self.route(post).ask("问题")
        self.assertEqual(caught.exception.stage, "protocol")
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0].endswith("/start"))

    def test_normalized_session_identity_allowed(self):
        for session in ("s", "session-s", "  session-s  "):
            with self.subTest(session=session):
                self.assertEqual(self.route(lambda u, b, h, t:
                    (202, snapshot(b, "completed", sessionId=session))).ask("问题"), "最终结果")

    def test_total_deadline_accepted_vs_unknown_and_each_http_bounded(self):
        for accepted in (False, True):
            with self.subTest(accepted=accepted):
                clock, calls, receipts = Clock(), [], []
                def post(url, body, headers, timeout):
                    calls.append((url, body, timeout, clock()))
                    if url.endswith("/result"):
                        clock.now += min(timeout, .4)
                    return (202 if url.endswith("/start") else 200), snapshot(body,
                        "pending" if accepted else "submitting", "accepted" if accepted else "not-sent")
                with self.assertRaises(DeliveryError) as caught:
                    self.route(post, clock, timeout=2, poll_wait=.2).ask_with_receipt("问题", lambda: True,
                        on_accepted=receipts.append)
                self.assertAlmostEqual(clock(), 2)
                self.assertEqual(caught.exception.stage, "deadline")
                self.assertEqual(caught.exception.delivery, "accepted" if accepted else "unknown")
                self.assertEqual(len(receipts), 1 if accepted else 0)
                self.assertTrue(all(timeout <= 2 - began + .000001 for _, _, timeout, began in calls))
                self.assertTrue(all(body.get("waitMs", 0) <= 10000 for _, body, _, _ in calls))

    def test_deadline_cannot_be_reset_by_progress_or_exceed_thirty_minutes(self):
        clock, calls = Clock(), []
        def post(url, body, headers, timeout):
            calls.append(url)
            if url.endswith("/result"):
                clock.now += min(timeout, body["waitMs"] / 1000 or timeout)
            return 202 if url.endswith("/start") else 200, snapshot(body)
        route = self.route(post, clock, timeout=99999)
        self.assertEqual(route.timeout, 1800)
        with self.assertRaises(DeliveryError) as caught:
            route.ask("问题")
        self.assertAlmostEqual(clock(), 1800)
        self.assertEqual(caught.exception.delivery, "accepted")
        self.assertEqual(sum(u.endswith("/start") for u in calls), 1)

    def test_terminal_failure_keeps_known_delivery(self):
        for delivery in ("not-sent", "unknown", "accepted"):
            with self.subTest(delivery=delivery):
                receipts = []
                def post(url, body, headers, timeout):
                    return 202, snapshot(body, "failed", delivery, message=SECRET)
                with self.assertRaises(DeliveryError) as caught:
                    self.route(post).ask_with_receipt("问题", lambda: True, on_accepted=receipts.append)
                self.assertEqual(caught.exception.delivery, delivery)
                self.assertEqual(caught.exception.accepted, delivery == "accepted")
                self.assertEqual(len(receipts), int(delivery == "accepted"))
                self.assertNotIn(SECRET, str(caught.exception))

    def test_accepted_cannot_regress_to_nonaccepted_snapshot(self):
        calls = []
        def post(url, body, headers, timeout):
            calls.append(url)
            return (202, snapshot(body)) if len(calls) == 1 else (200, snapshot(body, "failed", "not-sent"))
        with self.assertRaises(DeliveryError) as caught:
            self.route(post).ask("问题")
        self.assertEqual(caught.exception.stage, "protocol")
        self.assertEqual(caught.exception.delivery, "accepted")

    def test_callback_failure_does_not_abandon_lease(self):
        calls = []
        def post(url, body, headers, timeout):
            calls.append(url)
            return 202 if len(calls) == 1 else 200, snapshot(body, "pending" if len(calls) == 1 else "completed")
        def bad_callback(receipt):
            raise RuntimeError(SECRET)
        route = self.route(post)
        self.assertEqual(route.ask_with_receipt("问题", lambda: True, on_accepted=bad_callback), "最终结果")
        self.assertEqual(len(calls), 2)
        self.assertFalse(route._ask_lock.locked())

    def test_prestart_cancellation_and_empty_ask_have_no_delivery(self):
        calls = []
        route = self.route(lambda *args: calls.append(args))
        self.assertEqual(route.ask_with_receipt("问题", lambda: False, [b"image"]), "")
        self.assertEqual(route.ask("  "), "")
        self.assertEqual(calls, [])

    def test_upload_failure_definitely_not_sent_sanitized(self):
        calls = []
        def post(url, body, headers, timeout):
            calls.append(url)
            raise RuntimeError(SECRET)
        route = self.route(post)
        with self.assertRaises(DeliveryError) as caught:
            route.ask("问题", [b"fake-image"])
        e = caught.exception
        self.assertEqual((e.delivery, e.stage), ("not-sent", "upload"))
        self.assertIsNotNone(e.request_id)
        self.assertNotIn(SECRET, str(e))
        self.assertTrue(calls[0].endswith("/shot"))
        self.assertEqual(len(calls), 1)
        with self.assertRaises(DeliveryError) as direct:
            route.upload(b"fake-image")
        self.assertEqual(direct.exception.delivery, "not-sent")

    def test_uploads_once_check_current_before_each_and_start(self):
        calls, current = [], [True]
        def post(url, body, headers, timeout):
            calls.append((url, body))
            current[0] = False
            return 200, {"ok": True, "id": "synthetic-shot"}
        self.assertEqual(self.route(post).ask_with_receipt("问题", lambda: current[0], [b"a", b"b"]), "")
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0][0].endswith("/shot"))

    def test_uploaded_ids_in_single_start_no_voice_tts(self):
        calls, shot = [], [0]
        def post(url, body, headers, timeout):
            calls.append((url, body))
            if url.endswith("/shot"):
                shot[0] += 1
                return 200, {"ok": True, "id": "shot-%d" % shot[0]}
            return 202, snapshot(body, "completed")
        self.assertEqual(self.route(post).ask("", [b"a", b"b"]), "最终结果")
        self.assertEqual(calls[-1][1]["shots"], ["shot-1", "shot-2"])
        self.assertEqual(len(calls), 3)
        self.assertFalse(any("tts" in url or "voice" in url for url, _ in calls))

    def test_existing_entrypoints_and_unset_route(self):
        calls = []
        def post(url, body, headers, timeout):
            calls.append(url)
            return 202, snapshot(body, "completed")
        route = self.route(post)
        self.assertEqual(route.ask_if_current("问题", lambda: True), "最终结果")
        self.assertEqual(route.ask("问题"), "最终结果")
        self.assertEqual(len(calls), 2)
        self.assertIsInstance(make_llm({}), NoRoute)
        with self.assertRaises(RouteUnset) as caught:
            NoRoute().ask("问题")
        self.assertEqual(caught.exception.delivery, "not-sent")

    def test_cancelled_old_call_drains_and_holds_lock_before_next_start(self):
        entered, release, done = threading.Event(), threading.Event(), threading.Event()
        current, calls, old, new, receipts, errors = [True], [], [], [], [], []
        self.addCleanup(release.set)
        def post(url, body, headers, timeout):
            calls.append((url, dict(body)))
            if url.endswith("/start"):
                if body["text"] == "旧问题":
                    return 202, snapshot(body, "submitting", "not-sent")
                self.assertTrue(done.is_set(), "new start must wait for old host terminal")
                return 202, snapshot(body, "completed", reply="新回复")
            entered.set()
            self.assertTrue(release.wait(2))
            done.set()
            return 200, snapshot(body, "completed", reply="旧回复不能交给新turn")
        route = self.route(post)
        def run(fn, sink):
            try:
                sink.append(fn())
            except Exception as e:
                errors.append(e)
        first = threading.Thread(target=run, args=(lambda: route.ask_with_receipt("旧问题",
            lambda: current[0], on_accepted=receipts.append), old), daemon=True)
        second = threading.Thread(target=run, args=(lambda: route.ask("新问题"), new), daemon=True)
        first.start()
        self.assertTrue(entered.wait(1))
        current[0] = False
        second.start()
        end = time.monotonic() + 1
        while route.waiting != 1 and time.monotonic() < end:
            time.sleep(.001)
        self.assertEqual(route.waiting, 1)
        self.assertEqual(len(calls), 2)
        self.assertTrue(route._ask_lock.locked())
        release.set()
        first.join(2)
        second.join(2)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(old, [""])
        self.assertEqual(new, ["新回复"])
        self.assertEqual(len(receipts), 1, "cancelled callers still learn acceptance")
        starts = [body for url, body in calls if url.endswith("/start")]
        self.assertEqual(len(starts), 2)
        self.assertNotEqual(starts[0]["requestId"], starts[1]["requestId"])
        self.assertEqual(route.waiting, 0)

    def test_late_receipt_after_local_cancel_still_arrives_but_old_reply_does_not(self):
        clock, calls, receipts = Clock(), [], []
        def post(url, body, headers, timeout):
            calls.append(url)
            if url.endswith("/start"):
                return 202, snapshot(body, "submitting", "not-sent")
            clock.now += body["waitMs"] / 1000
            if clock() < 30:
                return 200, snapshot(body, "submitting", "unknown")
            return 200, snapshot(body, "completed" if clock() >= 360 else "pending")
        route = self.route(post, clock)
        self.assertEqual(route.ask_with_receipt("旧合成任务", lambda: clock() < 15,
                         on_accepted=lambda r: receipts.append((clock(), r))), "")
        self.assertEqual(clock(), 360)
        self.assertEqual(len(receipts), 1)
        self.assertEqual(receipts[0][0], 30)
        self.assertTrue(receipts[0][1]["accepted"])
        self.assertEqual(sum(url.endswith("/start") for url in calls), 1)
        self.assertFalse(route._ask_lock.locked())

    def test_cancelled_poll_faults_keep_draining_same_lease_with_bounded_backoff(self):
        clock, current, calls, receipts = Clock(), [True], [], []
        def post(url, body, headers, timeout):
            calls.append(url)
            if url.endswith("/start"):
                return 202, snapshot(body, "submitting", "not-sent")
            current[0] = False
            if len(calls) <= 5:
                raise OSError(SECRET)
            return 200, snapshot(body, "completed")
        route = self.route(post, clock, timeout=20, poll_retries=1)
        self.assertEqual(route.ask_with_receipt("旧任务", lambda: current[0], on_accepted=receipts.append), "")
        self.assertEqual(len(calls), 6)
        self.assertEqual(len(receipts), 1)
        self.assertLess(clock(), 20)
        self.assertTrue(any(s == 5 for s in clock.sleeps))
        self.assertEqual(sum(url.endswith("/start") for url in calls), 1)

    def test_cancelled_auth_or_wrong_job_does_not_retry_but_holds_possible_lease_to_deadline(self):
        for auth in (False, True):
            with self.subTest(auth=auth):
                clock, calls, current = Clock(), [], [True]
                def post(url, body, headers, timeout):
                    calls.append(url)
                    if url.endswith("/start"):
                        return 202, snapshot(body)
                    current[0] = False
                    if auth:
                        return 403, {"ok": False}
                    return 200, snapshot(body, "completed", requestId="wrong-job")
                route = self.route(post, clock, timeout=20)
                with self.assertRaises(DeliveryError) as caught:
                    route.ask_if_current("旧任务", lambda: current[0])
                self.assertEqual(caught.exception.delivery, "accepted")
                self.assertEqual(clock(), 20)
                self.assertEqual(len(calls), 2)
                self.assertFalse(route._ask_lock.locked())

    def test_cancelled_lock_waiter_never_sends_or_uploads(self):
        current, calls, out = [True], [], []
        route = self.route(lambda *args: calls.append(args))
        route._ask_lock.acquire()
        self.addCleanup(lambda: route._ask_lock.release() if route._ask_lock.locked() else None)
        thread = threading.Thread(target=lambda: out.append(route.ask_if_current("取消", lambda: current[0], [b"a"])),
                                  daemon=True)
        thread.start()
        end = time.monotonic() + 1
        while route.waiting != 1 and time.monotonic() < end:
            time.sleep(.001)
        self.assertEqual(route.waiting, 1)
        current[0] = False
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(out, [""])
        self.assertEqual(calls, [])
        self.assertEqual(route.waiting, 0)


if __name__ == "__main__":
    unittest.main()
