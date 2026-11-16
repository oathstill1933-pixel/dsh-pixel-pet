"""Progress protocol-1 routes: pure fake POST/clock, never services/models/audio.

Run: PYTHONPATH=runtime python -B -m unittest discover -s tests -p test_progress_route.py -v
"""
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'runtime'))  # runnable alone, not only after other tests
import unittest
from unittest.mock import patch

from pixelpet.voice.llm import DeliveryError, SessionRoute
from test_long_route import BASE, SECRET, Clock, snapshot


def update(seq, text=None, **fields):
    return dict(seq=seq, text=text or "公开段落%d" % seq, turn=1, **fields)


def progress(body, records=(), state="pending", **fields):
    records = list(records)
    return snapshot(body, state, updates=records,
                    updateSeq=max((u.get("seq", 0) for u in records), default=0), **fields)


class ProgressRoute(unittest.TestCase):
    def setUp(self):
        # A missed fake injection fails immediately instead of reaching a real host.
        network = patch("pixelpet.voice.llm._post_json", side_effect=AssertionError("network forbidden"))
        network.start()
        self.addCleanup(network.stop)

    def route(self, post, clock=None, **kw):
        clock = clock or Clock()
        return SessionRoute("session-s", host_base=BASE, key=SECRET, post=post,
                            clock=clock, sleep=clock.sleep, **kw)

    def test_pending_callback_happens_before_terminal_and_receipt_is_first(self):
        events, calls = [], []
        def post(url, body, headers, timeout):
            calls.append((url, dict(body)))
            self.assertEqual(headers, {"X-PixelPet-Key": SECRET})
            if url.endswith("/start"):
                return 202, snapshot(body, "submitting", "not-sent")
            if len(calls) == 2:
                self.assertEqual(body["afterSeq"], 0)
                return 200, progress(body, [update(1)])
            self.assertEqual(events, ["accepted", (1, "公开段落1")])
            self.assertEqual(body["afterSeq"], 1)
            return 200, progress(body, [update(2, "最终结果")], "completed")
        route = self.route(post)
        reply = route.ask_with_updates("合成问题", lambda: True,
            on_accepted=lambda r: events.append("accepted"),
            on_update=lambda u: events.append((u["seq"], u["text"])))
        events.append(reply)
        self.assertEqual(events, ["accepted", (1, "公开段落1"), (2, "最终结果"), "最终结果"])
        self.assertEqual(sum(url.endswith("/start") for url, _ in calls), 1)
        self.assertFalse(route._ask_lock.locked())

    def test_immediate_final_also_delivers_update_before_return(self):
        events = []
        def post(url, body, headers, timeout):
            self.assertTrue(url.endswith("/start"))
            return 202, progress(body, [update(1, "最终结果", messageId="m1")], "completed")
        reply = self.route(post).ask_with_updates("问题", lambda: True,
            on_accepted=lambda r: events.append("accepted"), on_update=events.append)
        self.assertEqual(events, ["accepted", update(1, "最终结果", messageId="m1")])
        self.assertEqual(reply, "最终结果")

    def test_reconnect_repeated_sequences_and_same_message_id_are_not_replayed(self):
        calls, seen = [], []
        def post(url, body, headers, timeout):
            calls.append((url, dict(body)))
            n = len(calls)
            if n == 1:
                return 202, progress(body, [update(1, messageId="same")])
            self.assertEqual(body["afterSeq"], 1 if n < 5 else 2)
            if n == 2:
                raise OSError(SECRET)
            if n == 3:
                return 200, progress(body, [update(1, messageId="same")])
            if n == 4:
                return 200, progress(body, [update(1, messageId="same"), update(2, messageId="same")])
            return 200, progress(body, [update(2, messageId="same"), update(3, messageId="new")], "completed")
        route = self.route(post)
        self.assertEqual(route.ask_with_updates("问题", lambda: True, on_update=seen.append), "最终结果")
        self.assertEqual([u["seq"] for u in seen], [1, 3])
        self.assertEqual(sum(url.endswith("/start") for url, _ in calls), 1)
        self.assertEqual(len({b["requestId"] for _, b in calls}), 1)

    def test_cursor_advanced_before_throwing_callback_without_abandoning_lease(self):
        calls, seen = [], []
        route = None
        def post(url, body, headers, timeout):
            calls.append(dict(body))
            self.assertTrue(route._ask_lock.locked())
            if len(calls) > 1:
                self.assertEqual(body["afterSeq"], 1)
            return (202 if len(calls) == 1 else 200), progress(body, [update(1)],
                "completed" if len(calls) == 3 else "pending")
        def callback(u):
            seen.append(u["seq"])
            self.assertTrue(route._ask_lock.locked())
            raise RuntimeError(SECRET)
        route = self.route(post)
        self.assertEqual(route.ask_with_updates("问题", lambda: True, on_update=callback), "最终结果")
        self.assertEqual(seen, [1])
        self.assertEqual(len(calls), 3)
        self.assertFalse(route._ask_lock.locked())

    def test_cancellation_drains_cursor_without_callbacks_or_start_repost(self):
        clock, calls, seen, receipts = Clock(), [], [], []
        current = [True]
        def post(url, body, headers, timeout):
            calls.append((url, dict(body)))
            n = len(calls)
            if n == 1:
                return 202, progress(body, [update(1)])
            clock.now += body["waitMs"] / 1000
            self.assertEqual(body["afterSeq"], n - 1)
            if n == 2:
                current[0] = False
            return 200, progress(body, [update(n)], "completed" if n == 4 else "pending")
        route = self.route(post, clock)
        self.assertEqual(route.ask_with_updates("旧任务", lambda: current[0],
            on_accepted=receipts.append, on_update=seen.append), "")
        self.assertEqual([u["seq"] for u in seen], [1])
        self.assertEqual(len(receipts), 1)
        self.assertEqual(len(calls), 4)
        self.assertEqual(sum(url.endswith("/start") for url, _ in calls), 1)
        self.assertFalse(route._ask_lock.locked())

    def test_receipt_callback_can_cancel_before_first_update(self):
        seen = []
        current = [True]
        def accepted(receipt):
            current[0] = False
        route = self.route(lambda u, b, h, t: (202, progress(b, [update(1)], "completed")))
        self.assertEqual(route.ask_with_updates("问题", lambda: current[0],
            on_accepted=accepted, on_update=seen.append), "")
        self.assertEqual(seen, [])

    def test_cancel_inside_callback_stops_rest_of_same_envelope(self):
        seen, current = [], [True]
        def callback(u):
            seen.append(u["seq"])
            current[0] = False
        route = self.route(lambda u, b, h, t: (202, progress(b, [update(1), update(2)], "completed")))
        self.assertEqual(route.ask_with_updates("问题", lambda: current[0], on_update=callback), "")
        self.assertEqual(seen, [1])

    def test_old_snapshot_without_optional_fields_and_old_entrypoints_stay_valid(self):
        seen, receipts, calls = [], [], []
        def post(url, body, headers, timeout):
            calls.append(url)
            return 202, snapshot(body, "completed")
        route = self.route(post)
        self.assertEqual(route.ask_with_updates("问题", lambda: True,
            on_accepted=receipts.append, on_update=seen.append), "最终结果")
        self.assertEqual(route.ask("问题"), "最终结果")
        self.assertEqual(route.ask_if_current("问题", lambda: True), "最终结果")
        self.assertEqual(route.ask_with_receipt("问题", lambda: True), "最终结果")
        self.assertEqual(seen, [])
        self.assertEqual(len(receipts), 1)
        self.assertEqual(len(calls), 4)

    def test_invalid_seq_turn_id_text_or_payload_rejected_before_any_callback(self):
        # Keep mutation cases explicit so each failure reports the offending field.
        bad_records = [[dict(update(1), seq=n)] for n in (0, -1, True, 1.0, "1", 2**53)]
        bad_records += [[update(2), update(1)], [update(1), update(1)]]
        bad_records += [[dict(update(1), turn=t)] for t in (2, True, "1", -1, 1.0)]
        bad_records += [[dict(update(1), messageId=m)] for m in (None, 1, "", " ", "m" * 121, "m\n", "m\x00", "m\x7f")]
        bad_records += [[dict(update(1), text=t)] for t in (None, 1, [], "", " ", "a" * 4001)]
        bad_records += [[dict(update(1), **fields)] for fields in (
            {"reasoning": SECRET}, {"channel": "analysis"}, {"role": "tool"}, {"payload": {"text": SECRET}})]
        bad_records += [["not-envelope"], [None], [update(i) for i in range(1, 66)],
                        [update(i, "a" * 4000) for i in range(1, 10)]]
        for records in bad_records:
            with self.subTest(records=repr(records)[:160]):
                seen, receipts, calls = [], [], []
                def post(url, body, headers, timeout):
                    calls.append(url)
                    # Deliberately hand-build so malformed seq isn't normalized away.
                    return 202, snapshot(body, updates=records, updateSeq=100)
                with self.assertRaises(DeliveryError) as error:
                    self.route(post).ask_with_updates("问题", lambda: True,
                        on_accepted=receipts.append, on_update=seen.append)
                self.assertEqual(error.exception.stage, "protocol")
                self.assertEqual(error.exception.delivery, "unknown")
                self.assertEqual(seen, [])
                self.assertEqual(receipts, [])
                self.assertEqual(len(calls), 1)
                self.assertNotIn(SECRET, str(error.exception))

    def test_invalid_envelope_cursor_and_unbound_turn_rejected(self):
        mutations = [dict(updateSeq=n) for n in (None, -1, True, 1.0, "1", 2**53)]
        mutations += [dict(updateSeq=0), dict(turn=None), dict(turn=True), dict(turn="1"),
                      dict(updates=None), dict(updates={}), dict(delivery="unknown", accepted=False, state="submitting")]
        for change in mutations:
            with self.subTest(change=change):
                def post(url, body, headers, timeout):
                    data = progress(body, [update(1)])
                    data.update(change)
                    return 202, data
                with self.assertRaises(DeliveryError):
                    self.route(post).ask_with_updates("问题", lambda: True)

    def test_turn_cannot_drift_after_accepted_receipt(self):
        calls, seen = [], []
        def post(url, body, headers, timeout):
            calls.append(url)
            if len(calls) == 1:
                return 202, progress(body, [update(1)])
            return 200, progress(body, [dict(update(2), turn=2)], "completed", turn=2)
        with self.assertRaises(DeliveryError) as error:
            self.route(post).ask_with_updates("问题", lambda: True, on_update=seen.append)
        self.assertEqual(error.exception.delivery, "accepted")
        self.assertEqual([u["seq"] for u in seen], [1])
        self.assertEqual(len(calls), 2)

    def test_optional_update_turn_and_id_are_legal_and_no_arbitrary_fields_escape(self):
        records = [{"seq": 1, "text": "公开"}, {"seq": 2, "text": "公开二", "turn": None}]
        seen = []
        def post(url, body, headers, timeout):
            return 202, progress(body, records, "completed", headers={"secret": SECRET}, reasoning=SECRET)
        self.assertEqual(self.route(post).ask_with_updates("问题", lambda: True, on_update=seen.append), "最终结果")
        self.assertEqual(seen, records)
        self.assertNotIn(SECRET, repr(seen))

    def test_receipt_mutation_cannot_inject_into_update_callback(self):
        seen = []
        def accepted(r):
            r["updates"][0]["text"] = SECRET
            r["updates"].append({"seq": 2, "text": SECRET})
            raise RuntimeError("fake UI enqueue failure")
        route = self.route(lambda u, b, h, t: (202, progress(b, [update(1)], "completed")))
        self.assertEqual(route.ask_with_updates("问题", lambda: True,
            on_accepted=accepted, on_update=seen.append), "最终结果")
        self.assertEqual(seen, [update(1)])

    def test_bounded_backlog_gap_advances_from_actual_records_not_high_water_only(self):
        seen, cursors = [], []
        def post(url, body, headers, timeout):
            if url.endswith("/start"):
                # start has no cursor and may contain only a high-water marker.
                return 202, snapshot(body, updates=[], updateSeq=130)
            cursors.append(body["afterSeq"])
            if len(cursors) == 1:
                return 200, progress(body, [update(i) for i in range(67, 131)])
            return 200, progress(body, [update(131)], "completed")
        route = self.route(post)
        self.assertEqual(route.ask_with_updates("问题", lambda: True, on_update=seen.append), "最终结果")
        self.assertEqual(cursors, [0, 130])
        self.assertEqual([u["seq"] for u in seen], list(range(67, 132)))

    def test_six_minute_virtual_queue_updates_do_not_reset_deadline_or_resubmit(self):
        clock, calls, receipts, seen = Clock(), [], [], []
        def post(url, body, headers, timeout):
            calls.append((url, dict(body), timeout))
            if url.endswith("/start"):
                return 202, snapshot(body, "submitting", "not-sent")
            clock.now += body["waitMs"] / 1000
            if clock() < 60:
                return 200, snapshot(body, "submitting", "unknown")
            seq = int(clock() / 10) - 5
            return 200, progress(body, [update(seq)], "completed" if clock() >= 360 else "pending")
        route = self.route(post, clock)
        result = route.ask_with_updates("六分钟合成排队任务", lambda: True,
            on_accepted=lambda r: receipts.append(clock()), on_update=lambda u: seen.append((clock(), u)))
        self.assertEqual(result, "最终结果")
        self.assertEqual(clock(), 360)
        self.assertEqual(receipts, [60])
        self.assertEqual(seen[0][0], 60)
        self.assertLess(seen[0][0], 360)
        self.assertEqual(len(seen), 31)
        self.assertEqual(sum(url.endswith("/start") for url, _, _ in calls), 1)
        self.assertTrue(all(timeout <= 30 for _, _, timeout in calls))
        self.assertTrue(all(body.get("waitMs", 0) <= 10000 for _, body, _ in calls))

    def test_progress_does_not_extend_original_hard_deadline(self):
        clock, calls, seen = Clock(), [], []
        def post(url, body, headers, timeout):
            calls.append(url)
            if url.endswith("/result"):
                clock.now += min(.5, timeout)
            return (202 if url.endswith("/start") else 200), progress(body, [update(len(calls))])
        route = self.route(post, clock, timeout=2, poll_wait=0)
        with self.assertRaises(DeliveryError) as error:
            route.ask_with_updates("问题", lambda: True, on_update=seen.append)
        self.assertEqual(error.exception.stage, "deadline")
        self.assertEqual(error.exception.delivery, "accepted")
        self.assertEqual(clock(), 2)
        self.assertGreater(len(seen), 1)
        self.assertEqual(sum(url.endswith("/start") for url in calls), 1)
        self.assertFalse(route._ask_lock.locked())

    def test_terminal_failure_still_delivers_valid_updates_then_keeps_acceptance(self):
        seen = []
        route = self.route(lambda u, b, h, t: (202, progress(b, [update(1)], "failed")))
        with self.assertRaises(DeliveryError) as error:
            route.ask_with_updates("问题", lambda: True, on_update=seen.append)
        self.assertEqual(seen, [update(1)])
        self.assertEqual(error.exception.delivery, "accepted")


if __name__ == "__main__":
    unittest.main()
