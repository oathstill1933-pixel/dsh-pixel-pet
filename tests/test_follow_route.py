"""Answer identity after a session switch: the requestId decides, not the stored session id.

「跟随外部桥会话」开着时，宿主可能在这一轮还没答完的时候把绑定会话换掉（桥新开了一间房）。
这一轮的回答仍然属于当初那个 requestId，所以收进度不能再拿 sessionId 和本地存的值比对——
比了就一定对不上，整轮结果会被当成「身份不匹配」丢掉。纯 fake POST/时钟，不碰服务/模型/音频。

Run (from the plugin directory): python -X utf8 -m unittest discover -s tests -p test_follow_route.py -v
"""
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'runtime'))  # runnable alone
import unittest
from unittest.mock import patch

from pixelpet.voice.llm import DeliveryError, SessionRoute
from test_long_route import BASE, SECRET, Clock, snapshot


class FollowSessionSwitch(unittest.TestCase):
    def setUp(self):
        # 任何真实网络调用都当场失败，而不是连到本机的宿主
        network = patch("pixelpet.voice.llm._post_json", side_effect=AssertionError("network forbidden"))
        network.start()
        self.addCleanup(network.stop)

    def route(self, post, clock=None, **kw):
        clock = clock or Clock()
        return SessionRoute("session-s", host_base=BASE, key=SECRET, post=post,
                            clock=clock, sleep=clock.sleep, **kw)

    def test_answer_from_a_switched_session_is_still_accepted(self):
        """宿主把会话换了，回复里的 sessionId 和本地存的不一样 —— 只要 requestId 对得上就照常收。"""
        calls = []

        def post(url, body, headers, timeout):
            calls.append((url, dict(body)))
            self.assertEqual(headers, {"X-PixelPet-Key": SECRET})
            if url.endswith("/start"):
                # 这一条是发给 session-s 的（宿主在跟随模式下会改成有效会话，但请求体照样带着本地值）
                self.assertEqual(body["sessionId"], "session-s")
                return 202, snapshot(body, "submitting", "not-sent", sessionId="session-other")
            return 200, snapshot(body, "completed", sessionId="session-other")

        reply = self.route(post).ask("合成问题")
        self.assertEqual(reply, "最终结果")
        self.assertEqual(sum(url.endswith("/start") for url, _ in calls), 1)

    def test_prefixed_and_unprefixed_session_ids_both_fine(self):
        """带不带 session- 前缀都收：判断的不是这个字段，所以没差。"""
        def post(url, body, headers, timeout):
            if url.endswith("/start"):
                return 202, snapshot(body, "submitting", "not-sent", sessionId="session-s")
            return 200, snapshot(body, "completed", sessionId="s")
        self.assertEqual(self.route(post).ask("合成问题"), "最终结果")

    def test_a_reply_for_another_request_id_is_still_refused(self):
        """按 requestId 认，别的任务的结果照样进不来。"""
        def post(url, body, headers, timeout):
            if url.endswith("/start"):
                return 202, snapshot(body, "submitting", "not-sent")
            return 200, snapshot(body, "completed", requestId="req-someone-else")

        with self.assertRaises(DeliveryError) as caught:
            self.route(post).ask("合成问题")
        self.assertEqual(caught.exception.stage, "protocol")
        self.assertIn(caught.exception.delivery, ("not-sent", "unknown"))

    def test_result_route_keeps_asking_for_the_same_request(self):
        """取结果那一侧也照旧带 sessionId + requestId；宿主那边按 requestId 找任务。"""
        seen = []

        def post(url, body, headers, timeout):
            seen.append((url, dict(body)))
            if url.endswith("/start"):
                return 202, snapshot(body, "submitting", "not-sent")
            return 200, snapshot(body, "completed", sessionId="session-new-home")

        self.route(post).ask("合成问题")
        result_bodies = [b for url, b in seen if url.endswith("/result")]
        self.assertTrue(result_bodies)
        request_ids = {b["requestId"] for _, b in seen}
        self.assertEqual(len(request_ids), 1)     # 全程只有一个 requestId
        self.assertTrue(all(b["sessionId"] == "session-s" for _, b in seen))


if __name__ == "__main__":
    unittest.main()
