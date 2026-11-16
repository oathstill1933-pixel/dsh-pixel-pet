"""Editable acknowledgement regressions: fake synthesis/clock/player, no real voice or mic."""
import os
import tempfile
import threading
import unittest
from types import SimpleNamespace

from helpers import ROOT  # noqa: F401
from test_voice import make_wav
from pixelpet.voice.bridge import VoiceBridge
from pixelpet.voice.interruption import is_playback_transcript


class AckTts:
    name = 'fake'

    def __init__(self, root):
        self.root = root
        self.calls = []
        self.block = False
        self.entered = threading.Event()
        self.release = threading.Event()
        self.duration = .05

    def synthesize(self, text, voice=None):
        self.calls.append((text, voice))
        if self.block:
            self.entered.set()
            if not self.release.wait(3):
                raise RuntimeError('test synthesizer was not released')
        return make_wav(os.path.join(self.root, 'fake-%d.wav' % len(self.calls)), self.duration)

    def close(self):
        self.release.set()


class AckLifecycle(unittest.TestCase):
    def bridge(self):
        temp = tempfile.TemporaryDirectory(prefix='pixelpet-ack-test-')
        self.addCleanup(temp.cleanup)
        tts = AckTts(temp.name)
        clock = SimpleNamespace(t=0.)
        plays, captions = [], []
        b = VoiceBridge(None, tts, None, play=plays.append, clock=lambda: clock.t,
                        interruption={'enabled': True, 'reply': '你说'},
                        on_caption=lambda *a: captions.append(a))
        self.addCleanup(b.close)
        return b, tts, clock, plays, captions

    def paused(self, b):
        b._turn = 1
        s = SimpleNamespace(turn=1, cancelled=False, paused=True, phase='ack', phase_at=0.,
                            started=0., pause_seq=1, utterance_at=None, parts=['原句。'], index=0, offset=0., current='原句。',
                            ack_stage='preparing', ack_timeout=90., ack_reply='你说')
        b._speech = s
        return s

    def start_ack(self, b, s):
        th = threading.Thread(target=b._acknowledge, args=(s,), daemon=True)
        th.start()
        self.addCleanup(th.join, 3)
        self.addCleanup(b.tts.release.set)
        return th

    def test_missing_cached_wav_is_regenerated(self):
        b, tts, _, _, _ = self.bridge()
        first = b._ack_file('你说')
        self.assertEqual(len(tts.calls), 1)
        # This path was produced by our fake synthesizer inside a private TemporaryDirectory.
        self.assertEqual(os.path.dirname(os.path.realpath(first)), os.path.realpath(tts.root))
        os.remove(first)
        second = b._ack_file('你说')
        self.assertEqual(len(tts.calls), 2)
        self.assertTrue(os.path.isfile(second))

    def test_invalid_cached_wav_is_regenerated(self):
        b, tts, _, _, _ = self.bridge()
        first = b._ack_file('你说')
        with open(first, 'wb') as f:
            f.write(b'not a playable wave')
        b._ack_file('你说')
        self.assertEqual(len(tts.calls), 2)

    def test_valid_cache_is_reused_and_custom_words_are_preserved(self):
        b, tts, _, _, _ = self.bridge()
        a = b._ack_file('你说')
        self.assertEqual(b._ack_file('你说'), a)
        self.assertEqual(tts.calls, [('你说', 'whale-girl')])

    def test_slow_new_words_are_not_cancelled_by_old_twelve_second_budget(self):
        b, tts, clock, plays, _ = self.bridge()
        s = self.paused(b)
        tts.block = True
        th = self.start_ack(b, s)
        self.assertTrue(tts.entered.wait(1))
        clock.t = 13.
        b.tick_interrupt()
        self.assertTrue(s.paused)
        self.assertEqual(s.phase, 'ack')
        tts.release.set()
        th.join(2)
        self.assertFalse(th.is_alive())
        self.assertEqual(len(plays), 1)
        self.assertEqual(s.phase, 'waiting')

    def test_preparation_has_finite_timeout_and_late_audio_is_discarded(self):
        b, tts, clock, plays, _ = self.bridge()
        s = self.paused(b)
        tts.block = True
        th = self.start_ack(b, s)
        self.assertTrue(tts.entered.wait(1))
        clock.t = 91.
        b.tick_interrupt()
        self.assertEqual(s.phase, 'waiting')
        self.assertTrue(s.paused)
        self.assertTrue(b.status().get('lastInterruptError'))
        tts.release.set()
        th.join(2)
        self.assertEqual(plays, [])

    def test_long_custom_audio_uses_its_playback_duration(self):
        b, tts, clock, plays, _ = self.bridge()
        s = self.paused(b)
        tts.duration = 20.
        entered, release = threading.Event(), threading.Event()
        def play(path):
            plays.append(path)
            entered.set()
            release.wait(3)
        b.play = play
        self.addCleanup(release.set)
        th = self.start_ack(b, s)
        self.assertTrue(entered.wait(1))
        clock.t = 13.
        b.tick_interrupt()
        self.assertTrue(s.paused)
        self.assertEqual(s.phase, 'ack')
        release.set()
        th.join(2)
        self.assertEqual(s.phase, 'waiting')

    def test_new_turn_cancels_pending_ack_without_stale_playback(self):
        b, tts, _, plays, _ = self.bridge()
        s = self.paused(b)
        tts.block = True
        th = self.start_ack(b, s)
        self.assertTrue(tts.entered.wait(1))
        b.interrupt()
        tts.release.set()
        th.join(2)
        self.assertEqual(plays, [])
        self.assertEqual(b.state, 'idle')
        self.assertIsNone(b.status().get('lastInterruptError'))

    def test_old_ack_cannot_take_over_a_second_pause_of_same_speech(self):
        b, tts, clock, plays, _ = self.bridge()
        s = self.paused(b)
        tts.block = True
        th = self.start_ack(b, s)
        self.assertTrue(tts.entered.wait(1))
        b.resume_interrupted()
        s.paused = True
        s.phase = 'ack'
        s.pause_seq += 1
        s.phase_at = clock.t
        tts.release.set()
        th.join(2)
        self.assertEqual(plays, [])
        self.assertEqual(s.phase, 'ack')

    def test_synthesis_error_is_visible_and_does_not_block_followup(self):
        b, tts, _, plays, captions = self.bridge()
        s = self.paused(b)
        def broken(*a):
            raise RuntimeError('fake speech backend unavailable')
        tts.synthesize = broken
        th = self.start_ack(b, s)
        th.join(2)
        self.assertEqual(plays, [])
        self.assertEqual(s.phase, 'waiting')
        self.assertIn('fake speech backend unavailable', b.status().get('lastInterruptError', ''))
        self.assertTrue(any('fake speech backend unavailable' in a[0] for a in captions))

    def test_speak_result_carries_its_own_turn_for_failure_feedback(self):
        b, _, _, plays, _ = self.bridge()
        result = b.speak('服务器出现异常了。')
        self.assertEqual(len(plays), 1)
        self.assertEqual(result.get('turn'), b._turn)

    def test_guarded_failure_cannot_cancel_newer_turn_even_after_waiting_for_lock(self):
        b, tts, _, plays, _ = self.bridge()
        result, entered = {}, threading.Event()
        stops = []
        b.stop_play = lambda: stops.append(True)
        old = b._turn
        def delayed():
            entered.set()
            result.update(b.speak_if_current('过期报错台词', old))
        with b._cv:
            th = threading.Thread(target=delayed, daemon=True)
            th.start()
            self.assertTrue(entered.wait(1))
            newer = b._begin()
        th.join(1)
        self.assertFalse(th.is_alive())
        self.assertTrue(result.get('cancelled'))
        self.assertEqual(b._turn, newer)
        self.assertEqual(tts.calls, [])
        self.assertEqual(plays, [])
        self.assertEqual(stops, [])

    def test_playback_timeout_stops_ack_and_still_accepts_followup(self):
        b, tts, clock, plays, _ = self.bridge()
        s = self.paused(b)
        entered, release = threading.Event(), threading.Event()
        stops = []
        def play(path):
            plays.append(path)
            entered.set()
            release.wait(3)
        def stop():
            stops.append(True)
            release.set()
        b.play, b.stop_play = play, stop
        self.addCleanup(release.set)
        th = self.start_ack(b, s)
        self.assertTrue(entered.wait(1))
        clock.t = 13.
        b.tick_interrupt()
        th.join(2)
        self.assertEqual(s.phase, 'waiting')
        self.assertTrue(s.paused)
        self.assertEqual(len(stops), 1)
        self.assertIn('播放超时', b.status()['lastInterruptError'])

    def test_hot_save_keeps_actual_ack_snapshot_in_echo_guard(self):
        b, _, _, _, _ = self.bridge()
        s = self.paused(b)
        s.ack_reply = '好的，我正在听。'
        b.configure_interrupt({'enabled': True, 'reply': '请继续讲'})
        self.assertTrue(is_playback_transcript('我正在听', b._echo_context(s)))
        self.assertTrue(is_playback_transcript('请继续讲', b._echo_context(s)))
        self.assertFalse(is_playback_transcript('换个话题', b._echo_context(s)))

    def test_expired_old_wait_cannot_resume_a_new_pause(self):
        for replace in (False, True):
            with self.subTest(replace=replace):
                b, _, clock, _, _ = self.bridge()
                s = self.paused(b)
                s.phase = 'waiting'; s.deadline = 0.
                original = b.resume_interrupted
                latest = []
                def race(*args, **kwargs):
                    n = SimpleNamespace(**vars(s)) if replace else s
                    n.pause_seq += 1
                    n.phase = 'ack'; n.ack_stage = 'preparing'; n.phase_at = clock.t
                    b._speech = n
                    latest.append(n)
                    return original(*args, **kwargs)
                b.resume_interrupted = race
                clock.t = 2.
                b.tick_interrupt()
                self.assertTrue(latest[0].paused)
                self.assertEqual(latest[0].phase, 'ack')

    def test_expired_state_cannot_resume_new_followup_check_on_same_pause(self):
        for same_phase in (False, True):
            with self.subTest(same_phase=same_phase):
                b, _, clock, _, _ = self.bridge()
                s = self.paused(b)
                s.phase = 'checking' if same_phase else 'waiting'
                s.deadline = 0.; s.phase_at = 0.
                original = b.resume_interrupted
                def race(*args, **kwargs):
                    s.phase = 'checking'; s.phase_at = clock.t
                    return original(*args, **kwargs)
                b.resume_interrupted = race
                clock.t = 31.
                b.tick_interrupt()
                self.assertTrue(s.paused)
                self.assertEqual(s.phase, 'checking')

    def test_waiting_state_is_published_under_the_same_pause_lock(self):
        b, _, _, _, _ = self.bridge()
        s = self.paused(b)
        changes = []
        original = b._set
        def publish(state, turn=None):
            changes.append((state, b._cv._is_owned()))
            return original(state, turn)
        b._set = publish
        th = self.start_ack(b, s)
        th.join(2)
        self.assertIn(('listening', True), changes)
        self.assertEqual(s.phase, 'waiting')

    def test_ack_cache_is_bounded_without_deleting_unowned_files(self):
        b, tts, _, _, _ = self.bridge()
        generated = [b._ack_file('新台词%d' % i) for i in range(12)]
        self.assertLessEqual(len(b._ack_cache), 8)
        self.assertTrue(all(os.path.isfile(p) for p in generated))


if __name__ == '__main__':
    unittest.main()
