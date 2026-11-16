"""Incremental speech actor: fake model/playback and tiny synthetic WAVs; no real audio/network."""
import threading
import time
import unittest
from types import SimpleNamespace
from helpers import tmpdir
from pixelpet.app import PetApp
from pixelpet.state import choose_state
from pixelpet.voice.bridge import VoiceBridge, _ProgressSpeech
from pixelpet.voice.stt import StubStt
from pixelpet.voice.tts import StubTts


def wait_for(fn, seconds=2):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if fn():return
        time.sleep(.005)
    raise AssertionError('timed out waiting for synthetic actor')

class Tts:
    name='synthetic'
    def __init__(self, fail=''):
        self.stub=StubTts(tmpdir());self.paths={};self.calls=[];self.fail=fail
    def synthesize(self,text,voice):
        self.calls.append(text)
        if self.fail and self.fail in text:raise RuntimeError('synthetic progress failure')
        path=self.stub.synthesize(text,voice);self.paths[path]=text;return path
    def close(self):self.stub.close()

class ProgressSpeechTests(unittest.TestCase):
    def make(self, route, tts=None, play=None):
        tts=tts or Tts();played=[];states=[]
        def player(path):
            played.append(tts.paths.get(path,path))
            if play:play(path)
        b=VoiceBridge(StubStt(),tts,route,play=player,on_state=states.append)
        self.addCleanup(b.close)
        return b,tts,played,states

    def test_process_is_spoken_before_final_then_returns_to_working_without_new_turn(self):
        ending=threading.Event();box={}
        class Route:
            def ask_with_updates(inner,text,current,images=None,on_accepted=None,on_update=None):
                on_accepted({'requestId':'job-progress','accepted':True})
                on_update({'seq':1,'text':'Opening explanation.'})
                ending.wait(3)
                on_update({'seq':2,'text':'Final result.'})
                return 'Final result.'
        b,tts,played,states=self.make(Route())
        self.addCleanup(ending.set)
        worker=threading.Thread(target=lambda:box.update(b.ask_text('work')),daemon=True);worker.start()
        wait_for(lambda:played==['Opening explanation.'] and b.state=='thinking')
        self.assertTrue(worker.is_alive());self.assertEqual(b._turn,1)
        self.assertIn('speaking',states)
        self.assertEqual(choose_state({'idle','running','speaking'},voice=b.state,manual='running'),'running')
        ending.set();worker.join(2);self.assertFalse(worker.is_alive())
        self.assertEqual(played,['Opening explanation.','Final result.'])
        self.assertEqual(tts.calls,['Opening explanation.','Final result.'])
        self.assertTrue(box['accepted']);self.assertTrue(box['streamed']);self.assertEqual(b.state,'idle')

    def test_duplicate_snapshot_and_same_final_are_not_spoken_twice(self):
        class Route:
            def ask_with_updates(inner,text,current,images=None,on_accepted=None,on_update=None):
                on_accepted({'requestId':'job-repeat','accepted':True})
                for update in [{'seq':1,'text':'Same sentence.'},{'seq':1,'text':'Same sentence.'},{'seq':2,'text':'Same sentence.'}]:on_update(update)
                return 'Same sentence.'
        b,tts,played,_=self.make(Route());out=b.ask_text('work')
        self.assertEqual(played,['Same sentence.']);self.assertTrue(out['streamed'])

    def test_progress_tts_failure_does_not_cancel_task_or_accepted_fact(self):
        observed=[]
        class Route:
            def ask_with_updates(inner,text,current,images=None,on_accepted=None,on_update=None):
                on_accepted({'requestId':'job-error','accepted':True})
                on_update({'seq':1,'text':'Bad opening.'})
                wait_for(lambda:b.last_progress_error is not None)
                observed.append((b._turn,b.last_error,b.state))
                on_update({'seq':2,'text':'Final result.'});return 'Final result.'
        b,tts,played,_=self.make(Route(),Tts(fail='Bad'))
        out=b.ask_text('work')
        self.assertEqual(observed,[(1,None,'thinking')]);self.assertEqual(played,['Final result.'])
        self.assertTrue(out['accepted']);self.assertNotIn('error',out)

    def test_speak_false_delivers_captions_but_never_synthesizes(self):
        class Route:
            def ask_with_updates(inner,text,current,images=None,on_accepted=None,on_update=None):
                on_accepted({'accepted':True,'requestId':'silent'})
                on_update({'seq':1,'text':'Progress caption.'});on_update({'seq':2,'text':'Final caption.'})
                return 'Final caption.'
        b,tts,played,states=self.make(Route());captions=[];b.on_caption=lambda text,*a:captions.append(text)
        out=b.ask_text('work',speak=False)
        self.assertEqual(tts.calls,[]);self.assertEqual(played,[]);self.assertNotIn('speaking',states)
        self.assertEqual(captions,['Progress caption.','Final caption.']);self.assertEqual(out['reply'],'Final caption.')

    def test_final_fallback_when_server_has_no_eligible_update(self):
        class Route:
            def ask_with_updates(inner,text,current,images=None,on_accepted=None,on_update=None):
                on_accepted({'accepted':True,'requestId':'fallback'});return 'Only final.'
        b,tts,played,_=self.make(Route());out=b.ask_text('work')
        self.assertEqual(played,['Only final.']);self.assertEqual(out['reply'],'Only final.')

    def test_new_local_turn_cancels_old_actor_without_late_final_replay(self):
        ending=threading.Event();playing=threading.Event();stop=threading.Event();old={}
        class Route:
            def ask_with_updates(inner,text,current,images=None,on_accepted=None,on_update=None):
                on_accepted({'accepted':True,'requestId':text})
                if text=='new':return 'New answer.'
                on_update({'seq':1,'text':'Old opening.'});ending.wait(3)
                on_update({'seq':2,'text':'Stale final.'});return 'Stale final.'
        b,tts,played,_=self.make(Route(),play=lambda path:(playing.set(),stop.wait(2)))
        b.stop_play=stop.set;self.addCleanup(ending.set);self.addCleanup(stop.set)
        worker=threading.Thread(target=lambda:old.update(b.ask_text('old')),daemon=True);worker.start()
        self.assertTrue(playing.wait(2))
        new=b.ask_text('new',speak=False);ending.set();worker.join(2)
        self.assertTrue(old.get('cancelled'));self.assertEqual(new['reply'],'New answer.')
        self.assertNotIn('Stale final.',played);self.assertEqual(b.state,'idle')

    def test_pending_audio_backlog_is_bounded_and_keeps_latest_paragraphs(self):
        first=threading.Event();release=threading.Event()
        class Route:pass
        b,tts,played,_=self.make(Route(),play=lambda path:(first.set(),release.wait(2)))
        self.addCleanup(release.set);turn=b._begin();actor=_ProgressSpeech(b,turn,True)
        actor.add({'seq':1,'text':'Paragraph one.'});self.assertTrue(first.wait(2))
        for seq in range(2,103):actor.add({'seq':seq,'text':'Paragraph '+str(seq)+'.'})
        self.assertLessEqual(actor.items.qsize(),8);self.assertGreater(b.progress_dropped,0)
        release.set();actor.finish();self.assertEqual(actor.last_text,'Paragraph 102.')

    def test_task_done_animation_waits_for_active_progress_speech(self):
        speaking=True
        voice=SimpleNamespace(_turn=7,status=lambda:{'progressSpeaking':speaking},last_error=None)
        app=SimpleNamespace(voice=voice,voice_state='speaking',manual='running',_manual_until=1,
            char=SimpleNamespace(states={'review','running'},total_ms=lambda state:100),bubble=SimpleNamespace(until=0))
        app.set_activity=lambda state:PetApp.set_activity(app,state)
        self.assertTrue(PetApp.set_activity(app,'done'));self.assertFalse(hasattr(app,'transient'))
        speaking=False;PetApp._on_voice(app,'thinking')
        self.assertFalse(hasattr(app,'transient'));self.assertIsNotNone(app._deferred_done)
        PetApp._on_voice(app,'idle')
        self.assertEqual(app.transient[0],'review');self.assertIsNone(app._deferred_done)

    def test_done_during_synthesis_or_between_queued_paragraphs_stays_deferred(self):
        phase='thinking'
        voice=SimpleNamespace(_turn=9,status=lambda:{'state':phase,'progressSpeaking':phase=='speaking'},last_error=None)
        app=SimpleNamespace(voice=voice,voice_state='thinking',manual='running',_manual_until=1,
            char=SimpleNamespace(states={'review','running'},total_ms=lambda state:100),bubble=SimpleNamespace(until=0))
        app.set_activity=lambda state:PetApp.set_activity(app,state)
        app.set_activity('done');self.assertFalse(hasattr(app,'transient'))
        for phase in ('speaking','thinking','speaking','thinking'):
            PetApp._on_voice(app,phase)
            self.assertFalse(hasattr(app,'transient'));self.assertIsNotNone(app._deferred_done)
        phase='idle';PetApp._on_voice(app,'idle')
        self.assertEqual(app.transient[0],'review');self.assertIsNone(app._deferred_done)

    def test_old_deferred_done_does_not_show_over_new_local_turn(self):
        voice=SimpleNamespace(_turn=8,last_error=None)
        app=SimpleNamespace(voice=voice,voice_state='speaking',_deferred_done=(voice,7),bubble=SimpleNamespace(until=0))
        app.set_activity=lambda state:self.fail('stale completion must not animate')
        PetApp._on_voice(app,'thinking');self.assertIsNone(app._deferred_done)

if __name__=='__main__':unittest.main()
