"""Sentence captions, retained playback, echo rejection and interruption ownership."""
import os
import threading
import time
import unittest
import wave
from unittest.mock import patch

from helpers import tmpdir
from test_voice import make_wav
from pixelpet.bubble import BubbleStack,paginate_dialogue,stack_positions,wrap_dialogue
from pixelpet.voice.bridge import VoiceBridge
from pixelpet.voice.interruption import interrupt_cfg,is_playback_transcript
from pixelpet.voice.llm import StubLlm
from pixelpet.voice.stt import StubStt
from pixelpet.voice.playback import PlaybackReference,Player,slice_wav
from pixelpet.voice.vad import Listener
from test_hub import FakeSd,tone,chunks,Clock,BarTk,FakePet


def wait_for(fn,timeout=3.):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if fn():return
        time.sleep(.01)
    raise AssertionError('condition timed out')


class Tts:
    name='fake'
    def __init__(self):self.data=tmpdir();self.calls=[];self.by_path={}
    def synthesize(self,text,voice=None):
        self.calls.append(text)
        path=make_wav(os.path.join(self.data,str(len(self.calls))+'.wav'),.05 if text in ('嗯，你说','请讲') else 5.)
        self.by_path[path]=text
        return path


class Harness:
    def __init__(self,reply='第一句。第二句。',**kw):
        self.clock=Clock();self.tts=Tts();self.stt=StubStt('等一下')
        self.llm=StubLlm(lambda text:reply)
        self.plays=[];self.captions=[];self.current=None;self.free=False
        self.b=VoiceBridge(self.stt,self.tts,self.llm,play=self.play,stop=self.stop,clock=self.clock,
                           on_caption=lambda *v:self.captions.append(v),**kw)
        self.box={}
    def play(self,path):
        with wave.open(path,'rb') as w:duration=w.getnframes()/w.getframerate()
        self.plays.append((path,duration))
        if self.tts.by_path.get(path) in ('嗯，你说','请讲') or self.free:return
        gate=threading.Event();self.current=gate;gate.wait(8.)
    def stop(self):
        if self.current:self.current.set()
    def start(self):
        self.thread=threading.Thread(target=lambda:self.box.update(self.b.ask_text('开始')),daemon=True)
        self.thread.start();wait_for(lambda:len(self.plays)>=1)
    def pause(self):
        self.clock.t+=2.5
        assert self.b.request_interrupt(b'probe')
        wait_for(lambda:self.b.interruption_phase=='waiting')
    def close(self):
        self.free=True;self.b.interrupt();self.stop()
        if hasattr(self,'thread'):self.thread.join(2.)


class InterruptTests(unittest.TestCase):
    def harness(self,**kw):
        h=Harness(**kw);self.addCleanup(h.close);return h

    def test_defaults_and_transcript_echo(self):
        self.assertEqual(interrupt_cfg(None),{'enabled':True,'reply':'嗯，你说'})
        self.assertEqual(interrupt_cfg({'enabled':'false','reply':42}),interrupt_cfg(None))
        self.assertTrue(is_playback_transcript('第一句话','现在是第一句话。'))
        self.assertFalse(is_playback_transcript('等一下','现在是第一句话。'))

    def test_six_seconds_resume_same_wav_cursor_without_resynthesis(self):
        h=self.harness();h.start();h.pause()
        s=h.b._speech;deadline=s.deadline;original=h.plays[0][0]
        self.assertAlmostEqual(s.offset,2.3,places=3)
        h.clock.t=deadline-.01;h.b.tick_interrupt()
        self.assertEqual(h.b.interruption_phase,'waiting')
        h.clock.t=deadline+.01;h.b.tick_interrupt()
        wait_for(lambda:len(h.plays)>=3)
        self.assertEqual(h.tts.calls.count('第一句。'),1)
        self.assertEqual(h.tts.calls.count('嗯，你说'),1)
        self.assertAlmostEqual(h.plays[2][1],2.7,places=2)
        with wave.open(original) as w:self.assertEqual(w.getnframes(),80000)
        h.free=True;h.stop();h.thread.join(2.)
        self.assertFalse(h.thread.is_alive())
        self.assertFalse(h.box.get('cancelled'))

    def test_followup_owns_new_turn_and_contains_listening_context(self):
        h=self.harness();h.start();h.pause()
        h.stt.texts=['换个话题吧'];h.free=True
        result=h.b.hear_followup(b'next',speak=False)
        h.thread.join(2.)
        self.assertEqual(result['heard'],'换个话题吧')
        self.assertIn('非逐字边界',h.llm.calls[-1])
        self.assertIn('未播的后续：第二句。',h.llm.calls[-1])
        self.assertTrue(h.box.get('interrupted'))
        h.clock.t+=60;h.b.tick_interrupt()
        self.assertEqual(len(h.plays),2)  # first sentence + acknowledgement only

    def test_noise_does_not_renew_deadline(self):
        h=self.harness();h.start();h.pause();deadline=h.b._speech.deadline
        h.stt.texts=['']
        h.clock.t=deadline-.1
        self.assertEqual(h.b.hear_followup(b'noise')['heard'],'')
        self.assertEqual(h.b._speech.deadline,deadline)
        h.clock.t=deadline+.1;h.b.tick_interrupt()
        wait_for(lambda:len(h.plays)>=3)

    def test_started_followup_may_finish_after_six_seconds(self):
        h=self.harness();h.start();h.pause();deadline=h.b._speech.deadline
        h.clock.t=deadline-.2;h.b.note_followup_started()
        h.clock.t=deadline+1;h.b.tick_interrupt()
        self.assertEqual(h.b.interruption_phase,'waiting')
        h.b.drop_followup()
        wait_for(lambda:len(h.plays)>=3)

    def test_disable_or_mic_off_resumes(self):
        for disable in (True,False):
            h=self.harness();h.start();h.pause()
            if disable:h.b.configure_interrupt({'enabled':False})
            else:h.b.set_barge_listening(False)
            wait_for(lambda:len(h.plays)>=3)
            self.assertEqual(h.b.interruption_phase,'')
            h.close()

    def test_disabled_never_pauses_and_custom_ack(self):
        h=self.harness(interruption={'enabled':False});h.start()
        self.assertFalse(h.b.request_interrupt(b'probe'))
        h.close()
        h=self.harness(interruption={'enabled':True,'reply':'请讲'});h.start();h.pause()
        self.assertIn('请讲',h.tts.calls)

    def test_echo_probe_does_not_pause(self):
        h=self.harness();h.stt.texts=['第一句'];h.start()
        h.b.request_interrupt(b'probe');wait_for(lambda:not h.b._probe_busy)
        self.assertEqual(h.b.interruption_phase,'')
        self.assertEqual(len(h.plays),1)

    def test_late_probe_cannot_pause_new_turn(self):
        h=self.harness();gate=threading.Event();started=threading.Event()
        def transcribe(*args):started.set();gate.wait(2.);return '等一下'
        h.stt.transcribe=transcribe;h.start();h.b.request_interrupt(b'probe')
        self.assertTrue(started.wait(2.))
        h.b.ask_text('新问题',speak=False);gate.set();h.thread.join(2.)
        wait_for(lambda:not h.b._probe_busy)
        self.assertEqual(h.b.state,'idle')
        self.assertNotIn('嗯，你说',h.tts.calls)

    def test_captions_follow_playback_and_nonspoken_reply_is_complete(self):
        h=self.harness();h.start()
        self.assertEqual([v[0] for v in h.captions],['第一句。'])
        h.free=True;h.stop();h.thread.join(2.)
        self.assertEqual([v[0] for v in h.captions],['第一句。','第二句。'])
        h.captions=[];h.b.ask_text('x',speak=False)
        self.assertEqual(h.captions,[('第一句。第二句。',0.)])

    def test_ack_failure_still_listens_and_resumes(self):
        h=self.harness();orig=h.tts.synthesize
        def synth(text,*args):
            if text=='嗯，你说':raise RuntimeError('ack error')
            return orig(text,*args)
        h.tts.synthesize=synth;h.start();h.pause()
        self.assertIn('ack error',h.b.last_interrupt_error)
        h.clock.t+=7;h.b.tick_interrupt();wait_for(lambda:len(h.plays)>=2)

    def test_expired_checking_drops_late_stt(self):
        h=self.harness();h.start();h.pause()
        gate=threading.Event();entered=threading.Event();out={}
        def slow(*args):entered.set();gate.wait(2.);return '新问题'
        h.stt.transcribe=slow
        th=threading.Thread(target=lambda:out.update(h.b.hear_followup(b'x')),daemon=True);th.start()
        self.assertTrue(entered.wait(1.));h.clock.t+=31;h.b.tick_interrupt()
        gate.set();th.join(2.)
        self.assertTrue(out.get('cancelled'))
        self.assertEqual(len(h.llm.calls),1)


class TranscriptEchoTests(unittest.TestCase):
    SPOKEN='今天天气很好啊我们出去玩吧，然后去公园散步。'

    def test_fragments_and_homophones_are_echo(self):
        for heard in ('今天天气很好呀','公园散布','天气很好啊我们出去','我们出去玩吧','然后去公园散步','今天天汽很好啊'):
            with self.subTest(heard=heard):self.assertTrue(is_playback_transcript(heard,self.SPOKEN))

    def test_new_sentences_still_interrupt(self):
        for heard in ('停一下','等一下我有个问题','换个话题吧','帮我查一下明天的航班','公园在哪里呀','不对不对你说错了'):
            with self.subTest(heard=heard):self.assertFalse(is_playback_transcript(heard,self.SPOKEN))

    def test_neighbouring_sentences_and_acknowledgement(self):
        ctx=['第一句先说天气。','现在讲第二句。','第三句准备出门。','嗯，你说']
        for heard in ('先说天气','准备出门','嗯你说','嗯，你说','第二句。第三句准备'):
            with self.subTest(heard=heard):self.assertTrue(is_playback_transcript(heard,ctx))
        self.assertFalse(is_playback_transcript('你刚才说什么',ctx))
        self.assertFalse(is_playback_transcript('等一下',['','','','']))


class RearmTests(unittest.TestCase):
    def harness(self,**kw):
        h=Harness(**kw);self.addCleanup(h.close);return h

    def test_next_sentence_echo_does_not_pause_and_rearms(self):
        rearms=[]
        h=self.harness(reply='第一句。第二句准备出门。',on_barge_rearm=lambda:rearms.append(1))
        h.stt.texts=['第二句准备'];h.start()
        self.assertEqual(len(rearms),1,'every sentence start re-arms the detector')
        h.clock.t+=2.;self.assertTrue(h.b.request_interrupt(b'probe'))
        wait_for(lambda:not h.b._probe_busy)
        wait_for(lambda:len(rearms)==2)
        self.assertEqual(h.b.interruption_phase,'')
        h.clock.t+=2.;h.stt.texts=['等一下我有个问题']
        self.assertTrue(h.b.request_interrupt(b'probe'),'a fresh probe is allowed after an echo verdict')
        wait_for(lambda:h.b.interruption_phase=='waiting')

    def test_ack_echo_in_followup_keeps_waiting(self):
        h=self.harness();h.start();h.pause()
        h.stt.texts=['嗯你说']
        self.assertEqual(h.b.hear_followup(b'echo')['heard'],'')
        self.assertEqual(h.b.interruption_phase,'waiting')
        self.assertEqual(len(h.llm.calls),1)

class EchoTests(unittest.TestCase):
    def test_delayed_echo_suppressed_but_mixed_human_voice_survives(self):
        import numpy as np
        clock=Clock();ref=PlaybackReference(clock=clock)
        self.assertTrue(ref.available)
        rng=np.random.default_rng(7)
        samples=(rng.normal(0,2000,48000)).astype('<i2')
        path=os.path.join(tmpdir(),'echo.wav')
        with wave.open(path,'wb') as w:
            w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(samples.tobytes())
        ref.start(path);clock.t+=1.1
        echo=samples[13000:14600].astype(np.float32)*.6
        self.assertEqual(ref.filter(echo.astype('<i2').tobytes()),b'\0'*3200)
        human=rng.normal(0,900,1600)
        mixed=ref.filter((echo+human).astype('<i2').tobytes())
        residual=np.frombuffer(mixed,dtype='<i2')
        human-=human.mean();residual=residual.astype(float)-residual.mean()
        correlation=np.sum(human*residual)/np.sqrt(np.sum(human*human)*np.sum(residual*residual))
        self.assertGreater(correlation,.97)
        ref.stop();self.assertFalse(ref.active)

    def test_slice_preserves_source_and_stop_generation_blocks_stale_play(self):
        path=make_wav(os.path.join(tmpdir(),'full.wav'),2.)
        cut,temp=slice_wav(path,.6)
        with wave.open(cut) as w:self.assertEqual(w.getnframes(),22400)
        with wave.open(path) as w:self.assertEqual(w.getnframes(),32000)
        os.remove(temp)
        p=Player();generation=p.generation;p.stop()
        with patch.object(p.reference,'start') as start:
            p.play(path,expected=generation)
            start.assert_not_called()

    def test_listener_rearm_allows_a_new_probe_without_epoch_change(self):
        heard=[];sent=threading.Event()
        lst=Listener(lambda pcm:None,sd=FakeSd,on_barge=lambda pcm:(heard.append(pcm),sent.set()))
        lst.start();self.addCleanup(lst.stop)
        lst.set_playback_mode(True,lambda pcm:pcm)
        for pcm in chunks(tone(.8,2400)):lst._cb(pcm,1600,None,None)
        self.assertTrue(sent.wait(1.));sent.clear()
        for pcm in chunks(tone(.8,2400)):lst._cb(pcm,1600,None,None)
        time.sleep(.05);self.assertEqual(len(heard),1)
        epoch=lst._epoch;lst.rearm_barge()
        for pcm in chunks(tone(.8,2400)):lst._cb(pcm,1600,None,None)
        self.assertTrue(sent.wait(1.));self.assertEqual(len(heard),2)
        self.assertEqual(lst._epoch,epoch)
        # buffered audio from before the re-arm is not carried into the next probe
        self.assertLessEqual(len(heard[1]),len(b''.join(chunks(tone(.8,2400)))))
    def test_listener_requires_sustained_voice_and_filters_off_audio_thread(self):
        heard=[];threads=[];done=threading.Event()
        def processor(pcm):threads.append(threading.get_ident());return pcm
        lst=Listener(lambda pcm:None,sd=FakeSd,on_barge=lambda pcm:(heard.append(pcm),done.set()))
        lst.start();self.addCleanup(lst.stop)
        lst.set_playback_mode(True,processor)
        for pcm in chunks(tone(.4,2400)):lst._cb(pcm,1600,None,None)
        time.sleep(.05);self.assertEqual(heard,[])
        for pcm in chunks(tone(.4,2400)):lst._cb(pcm,1600,None,None)
        self.assertTrue(done.wait(1.));self.assertEqual(len(heard),1)
        self.assertNotIn(threading.get_ident(),threads)
        for pcm in chunks(tone(.8,2400)):lst._cb(pcm,1600,None,None)
        time.sleep(.05);self.assertEqual(len(heard),1)


class PaginationTests(unittest.TestCase):
    def test_every_character_survives_many_pages(self):
        text=('你好，鲸鱼娘。 ABC-123\n\n这里还有第二段。'*50)+'最后一个字'
        pages=paginate_dialogue(text,len,18,6)
        self.assertGreater(len(pages),3)
        self.assertEqual(''.join(''.join(pages).split()),''.join(text.split()))
        for page in pages:self.assertNotIn('…',wrap_dialogue(page,len,18,6))

    def test_english_word_wrap_never_reclips_a_page(self):
        text=' '.join(['abcdefghijklmnop']*45)
        pages=paginate_dialogue(text,len,20,6)
        for page in pages:self.assertNotIn('…',wrap_dialogue(page,len,20,6))
        self.assertEqual(''.join(''.join(pages).split()),''.join(text.split()))

    def test_stack_fits_above_below_and_negative_monitor_coordinates(self):
        for body,work in [((200,700,400,900),(0,0,1000,1000)),((200,1,400,201),(0,0,1000,1000)),
                          ((-900,650,-700,850),(-1920,0,0,1080))]:
            sizes=[(280,120),(240,160),(260,140)]
            placements=stack_positions(body,sizes,work)
            rects=[]
            for i,x,y,tail,tip in placements:
                w,h=sizes[i];wl,wt,wr,wb=work
                self.assertTrue(wl<=x and x+w<=wr and wt<=y and y+h<=wb)
                for ox,oy,ow,oh in rects:self.assertTrue(y+h<=oy or oy+oh<=y)
                rects.append((x,y,w,h))


class StackTk(BarTk):
    def test_page_is_displayed_exactly_as_measured(self):
        pet=FakePet(self.root,{})
        pet.work_area=lambda:(0,0,1920,1080)
        pet.body_screen=lambda:(600,800,800,1000)
        stack=BubbleStack(pet);self.addCleanup(stack.destroy)
        # a page boundary could otherwise split "**...**" or "`...`" and a second clean would eat/alter it
        text='改好了：`__init__.py` 里的 **导出** 补上了，2 * 3 * 4 = 24。'+'海底小故事讲到一半。'*40
        pages=stack._pages(text)
        stack.show(text,8.)
        shown=[]
        while True:
            self.root.update();shown.append(stack.cards[-1].label.cget('text'))
            if not stack.pending:break
            stack.next_at=0.;stack.follow()
        self.assertEqual(shown,[p.strip('\n') for p in pages])
        self.assertIn('* 3 * 4 = 24',shown[0]);self.assertIn('__init__.py',shown[0])

    def test_three_cards_and_long_reply_queue(self):

        pet=FakePet(self.root,{})
        pet.work_area=lambda:(0,0,1920,1080)
        pet.body_screen=lambda:(600,800,800,1000)
        stack=BubbleStack(pet);self.addCleanup(stack.destroy)
        for i in range(4):stack.show_caption('第%d句话。'%i,2.)
        self.root.update()
        self.assertEqual(len(stack.cards),3)
        self.assertEqual([c.full_text for c in stack.cards],['第1句话。','第2句话。','第3句话。'])
        stack.show('海底小故事。'*180,8.)
        self.assertGreater(len(stack.pending),0)
        while stack.pending:stack.next_at=0.;stack.follow()
        self.assertTrue(stack.cards[-1].full_text.endswith('海底小故事。'))


class AppIntegration(BarTk):
    def make_app(self):
        from pixelpet.app import PetApp
        from helpers import make_character
        root_dir=tmpdir();make_character(root_dir,'tester')
        app=PetApp(self.root,root_dir,data_dir=tmpdir(),character='tester',offscreen=True)
        self.app=app
        app._fake_sd=FakeSd
        return app

    def tearDown(self):
        if hasattr(self,'app'):
            self.app.quit();self.root=None
        elif self.root is not None:
            try:self.root.destroy()
            except Exception:pass

    def test_speaking_only_opens_detector_with_live_echo_reference_and_switch(self):
        from types import SimpleNamespace
        app=self.make_app();app.set_listening(True)
        app.voice_state='speaking'
        app.voice.player=SimpleNamespace(reference=SimpleNamespace(active=True,available=True))
        app._tick_hub(time.monotonic())
        self.assertFalse(app.listener._paused)
        self.assertTrue(app.listener._playback)
        app.voice.configure_interrupt({'enabled':False})
        app._tick_hub(time.monotonic())
        self.assertTrue(app.listener._paused)
        app.voice.player=None  # restore the fake before cleanup

    def test_followup_events_do_not_cancel_retained_audio(self):
        from types import SimpleNamespace
        app=self.make_app();events=[]
        app.voice=SimpleNamespace(interruption_phase='waiting',note_followup_started=lambda:events.append('start'),
                                  drop_followup=lambda:events.append('drop'),close=lambda:None)
        app._hands_free_event('start');app._hands_free_event('drop')
        app._hub_voice=lambda pcm,followup=False:events.append(('segment',followup))
        app._hands_free_segment(b'voice')
        self.assertEqual(events,['start','drop',('segment',True)])


if __name__=='__main__':unittest.main()
