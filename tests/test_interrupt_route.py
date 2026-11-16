"""Reproduce an AI tool speaking before the originating HTTP turn has finished."""
import threading
import unittest
from types import SimpleNamespace

from helpers import tmpdir
from test_conversation import Harness,wait_for
import test_conversation as conversation
from pixelpet.app import PetApp
from pixelpet.voice.bridge import VoiceBridge
from pixelpet.voice.llm import SessionRoute
from pixelpet.voice.stt import StubStt
from pixelpet.voice.tts import StubTts


class RouteOwnership(unittest.TestCase):
    def test_interruption_waits_for_original_ai_tool_turn_then_delivers_followup(self):
        h=Harness();self.addCleanup(h.close)
        original=threading.Event();entered=threading.Event();calls=[];old={};follow={}
        self.addCleanup(original.set)
        def post(url,body,headers,timeout):
            calls.append(body)
            if len(calls)==1:
                entered.set();original.wait(4.)
                return 200,{'ok':True,'protocol':1,'requestId':body['requestId'],'sessionId':body['sessionId'],
                            'state':'completed','delivery':'accepted','accepted':True,'reply':'旧回复不能再播。'}
            if not original.is_set():return 409,{'ok':False,'message':'上一句还没回完'}
            return 200,{'ok':True,'protocol':1,'requestId':body['requestId'],'sessionId':body['sessionId'],
                        'state':'completed','delivery':'accepted','accepted':True,'reply':'好的，已经停下了。'}
        h.b.llm=SessionRoute('s',host_base='http://127.0.0.1:3080/dsh-pixel-pet',key='test',post=post)
        first=threading.Thread(target=lambda:old.update(h.b.ask_text('念一段长文本')),daemon=True)
        first.start();self.assertTrue(entered.wait(2.))
        # The model calls pixelpet_say while the originating ask is still in flight.
        h.thread=threading.Thread(target=lambda:h.box.update(h.b.speak('第一句。第二句。')),daemon=True)
        h.thread.start();wait_for(lambda:len(h.plays)==1)
        h.pause();h.stt.texts=['不说了，就这样打断。']
        next_turn=threading.Thread(target=lambda:follow.update(h.b.hear_followup(b'new speech',speak=False)),daemon=True)
        next_turn.start()
        wait_for(lambda:h.b.status()['routeWaiting'])
        self.assertEqual(len(calls),1)
        self.assertTrue(next_turn.is_alive())
        original.set();first.join(2.);next_turn.join(2.);h.thread.join(2.)
        self.assertFalse(next_turn.is_alive())
        self.assertTrue(old.get('cancelled'))
        self.assertTrue(h.box.get('interrupted'))
        self.assertEqual(follow['heard'],'不说了，就这样打断。')
        self.assertEqual(follow['reply'],'好的，已经停下了。')
        self.assertNotIn('error',follow)
        self.assertEqual(len(calls),2)
        self.assertIn('不说了，就这样打断。',calls[1]['text'])
        self.assertEqual(len(h.plays),2)  # old sentence and acknowledgement; no stale replay
        self.assertFalse(h.b.status()['routeWaiting'])

    def test_cancelled_waiter_is_not_sent_after_the_old_request_finishes(self):
        gate=threading.Event();entered=threading.Event();calls=[];one={};two={}
        self.addCleanup(gate.set)
        def post(url,body,headers,timeout):
            calls.append(body);entered.set();gate.wait(3.)
            return 200,{'ok':True,'protocol':1,'requestId':body['requestId'],'sessionId':body['sessionId'],
                        'state':'completed','delivery':'accepted','accepted':True,'reply':'回复'}
        route=SessionRoute('s',host_base='http://127.0.0.1:3080/dsh-pixel-pet',key='test',post=post)
        b=VoiceBridge(StubStt(),StubTts(tmpdir()),route,play=lambda path:None)
        self.addCleanup(b.close)
        first=threading.Thread(target=lambda:one.update(b.ask_text('旧问题',speak=False)),daemon=True)
        second=threading.Thread(target=lambda:two.update(b.ask_text('后来又取消的问题',speak=False)),daemon=True)
        first.start();self.assertTrue(entered.wait(1.));second.start()
        wait_for(lambda:route.waiting==1);b.interrupt();second.join(1.)
        self.assertFalse(second.is_alive());self.assertTrue(two.get('cancelled'))
        gate.set();first.join(2.)
        self.assertEqual(len(calls),1)
        self.assertEqual(b.state,'idle')

    def test_voice_send_failure_restores_transcript_even_without_screenshots(self):
        restored=[];done=threading.Event()
        def sent(*args):restored.append(args);done.set()
        app=SimpleNamespace(hub=SimpleNamespace(take_shots=lambda:[],sent=sent),
            hub_cfg=lambda:{'speak':True},_prewarm=lambda:None,post_ui=lambda fn:fn(),
            voice=SimpleNamespace(hear=lambda *a,**k:{'heard':'不说了，就这样打断。','error':'会话忙'}))
        PetApp._hub_voice(app,b'pcm')
        self.assertTrue(done.wait(2.))
        self.assertEqual(restored,[(False,'不说了，就这样打断。',[])])

    def test_accepted_interruption_does_not_restore_already_delivered_transcript(self):
        restored=[];done=threading.Event()
        def post_ui(fn):fn();done.set()
        def hear(*a,**k):done.set();return {'heard':'旧语音','cancelled':True,'interrupted':True}
        app=SimpleNamespace(hub=SimpleNamespace(take_shots=lambda:[],sent=lambda *a:restored.append(a)),
            hub_cfg=lambda:{'speak':True},_prewarm=lambda:None,post_ui=post_ui,voice=SimpleNamespace(hear=hear))
        PetApp._hub_voice(app,b'pcm');self.assertTrue(done.wait(2.))
        self.assertEqual(restored,[])


class ListenerRestore(unittest.TestCase):
    setUp=conversation.AppIntegration.setUp
    make_app=conversation.AppIntegration.make_app
    tearDown=conversation.AppIntegration.tearDown
    def test_explicit_listener_restore_is_idempotent_and_requires_boolean(self):
        app=self.make_app()
        self.assertFalse(app.command({'cmd':'hub','action':'listen','on':'true'})[0])
        self.assertTrue(app.command({'cmd':'hub','action':'listen','on':True})[3]['listening'])
        listener=app.listener
        self.assertTrue(app.command({'cmd':'hub','action':'listen','on':True})[0])
        self.assertIs(app.listener,listener)
        self.assertFalse(app.command({'cmd':'hub','action':'listen','on':False})[3]['listening'])
