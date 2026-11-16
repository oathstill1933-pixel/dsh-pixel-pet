"""Receipt/UI regressions: fake route/UI/thread; no model, real Tk, mic or speaker."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from helpers import tmpdir
from pixelpet.hub import HubBar, HubModel
from pixelpet.app import PetApp
from pixelpet.voice.bridge import VoiceBridge
from pixelpet.voice.llm import DeliveryError, StubLlm
from pixelpet.voice.stt import StubStt
from pixelpet.voice.tts import StubTts

class Var:
    def __init__(self, model, value=''): self.m,self.value=model,value
    def get(self):return self.value
    def set(self,value):self.value=value;self.m.set_draft(value)

class DeliveryTests(unittest.TestCase):
    def make(self, voice=None):
        hub=HubBar.__new__(HubBar);hub.m=HubModel();hub.var=Var(hub.m,'old text')
        hub.m.add_shot({'png':b'old synthetic image'});hub.refresh=lambda:None;hub._focus=lambda:None
        notes=[]
        app=SimpleNamespace(hub=hub,voice=voice,hub_cfg=lambda:{'speak':True},_prewarm=lambda:None,
            post_ui=lambda fn:fn(),bubble=SimpleNamespace(show=lambda text,*args:notes.append(text)))
        hub.pet=SimpleNamespace(hub_send_ticket=lambda text,shots,ticket:PetApp.hub_send(app,text,shots,send_id=ticket))
        return hub,app,notes

    def drive(self, hub):
        work=[]
        class QueueThread:
            def __init__(self,target,args=(),**kw):self.target,self.args=target,args
            def start(self):work.append(lambda:self.target(*self.args))
        with patch('pixelpet.app.threading.Thread',QueueThread):
            hub.send()
        self.assertEqual(hub.var.get(),'');self.assertFalse(hub.m.shots);self.assertTrue(hub.m.sending)
        return work

    def test_receipt_clears_sending_before_final_error_without_restoring(self):
        hub,app,notes=self.make()
        def ask(text,**kw):
            kw['on_accepted']({'accepted':True,'requestId':'fake-one'})
            self.assertFalse(hub.m.sending)
            return {'error':'synthesis failed','accepted':True,'delivery':'accepted'}
        app.voice=SimpleNamespace(ask_text=ask)
        self.drive(hub).pop()()
        self.assertEqual(hub.var.get(),'');self.assertEqual(hub.m.shots,[])
        self.assertFalse(hub.m.sending);self.assertIn('消息已送达',notes[-1])

    def test_only_definitely_unsent_failure_restores_original_text_and_shot(self):
        hub,app,notes=self.make(SimpleNamespace(ask_text=lambda *a,**k:{'error':'offline','delivery':'not-sent'}))
        self.drive(hub).pop()()
        self.assertEqual(hub.var.get(),'old text');self.assertEqual(len(hub.m.shots),1)
        self.assertEqual(hub.m.delivery,'not-sent')

    def test_unknown_delivery_never_recovers_or_resends(self):
        hub,app,notes=self.make(SimpleNamespace(ask_text=lambda *a,**k:{'error':'socket','delivery':'unknown'}))
        self.drive(hub).pop()()
        self.assertEqual(hub.var.get(),'');self.assertEqual(hub.m.shots,[])
        self.assertEqual(hub.m.recoveries,[]);self.assertIn('避免重复发送',notes[-1])

    def test_new_draft_preserved_and_unsent_original_has_explicit_recovery(self):
        hub,app,notes=self.make(SimpleNamespace(ask_text=lambda *a,**k:{'error':'offline','delivery':'not-sent'}))
        work=self.drive(hub)
        hub.var.set('new draft');hub.m.add_shot({'png':b'new image'})
        work.pop()()
        self.assertEqual(hub.var.get(),'new draft');self.assertEqual(hub.m.shots[0]['png'],b'new image')
        self.assertEqual(len(hub.m.recoveries),1);self.assertFalse(hub.recover())
        hub.var.set('');hub.m.shots=[]
        self.assertTrue(hub.recover());self.assertEqual(hub.var.get(),'old text')
        self.assertEqual(hub.m.shots[0]['png'],b'old synthetic image')

    def test_old_ticket_cannot_clear_restore_or_ack_a_newer_send(self):
        hub,app,notes=self.make();hub.m.active_send=2;hub.m.sending=True;hub.m.delivery='submitting'
        self.assertFalse(hub.accepted(1))
        self.assertFalse(hub.finish_send(1,False,'not-sent','old reply',[]))
        self.assertTrue(hub.m.sending);self.assertEqual(hub.m.active_send,2)
        self.assertEqual(hub.var.get(),'old text')

    def test_voice_failure_queues_recovery_without_touching_typed_send(self):
        hub,app,notes=self.make();hub.var.set('new typed');hub.m.active_send=2;hub.m.sending=True
        hub.m.shots=[]
        PetApp._finish_hub_delivery(app,hub,None,{'error':'STT failed','delivery':'not-sent'},'', [{'png':b'voice shot'}])
        self.assertTrue(hub.m.sending);self.assertEqual(hub.m.active_send,2)
        self.assertEqual(hub.var.get(),'new typed');self.assertEqual(hub.m.recoveries[0][1][0]['png'],b'voice shot')
        self.assertIn('右键输入框',notes[-1])

    def test_callbacks_from_replaced_view_are_ignored(self):
        hub,app,notes=self.make();app.hub=SimpleNamespace()
        PetApp._finish_hub_delivery(app,hub,1,{'error':'late','delivery':'not-sent'},'stale',[])
        self.assertEqual(notes,[]);self.assertEqual(hub.var.get(),'old text')

    def test_accepted_fact_cannot_be_downgraded_by_a_late_error(self):
        hub,app,notes=self.make();hub.m.active_send=1;hub.var.set('');hub.m.shots=[]
        hub.accepted(1);hub.finish_send(1,False,'not-sent','must not restore',[])
        self.assertEqual(hub.var.get(),'');self.assertEqual(hub.m.delivery,'accepted')

class BridgeFacts(unittest.TestCase):
    def test_legacy_success_then_tts_failure_is_still_delivered(self):
        class BrokenTts:
            name='fake'
            def synthesize(self,*args):raise RuntimeError('synthetic TTS failure')
            def close(self):pass
        b=VoiceBridge(StubStt(),BrokenTts(),StubLlm(lambda text:'reply'),play=lambda path:None)
        self.addCleanup(b.close)
        receipts=[];out=b.ask_text('hello',on_accepted=receipts.append)
        self.assertIn('error',out);self.assertEqual(out['delivery'],'accepted');self.assertTrue(out['accepted'])
        self.assertEqual(len(receipts),1)

    def test_receipt_then_poll_failure_keeps_request_and_delivery(self):
        class Route:
            def ask_with_receipt(self,text,is_current,images=None,on_accepted=None):
                on_accepted({'requestId':'job-one','accepted':True})
                raise DeliveryError('poll error','accepted','job-one','result')
        b=VoiceBridge(StubStt(),StubTts(tmpdir()),Route(),play=lambda path:None);self.addCleanup(b.close)
        out=b.ask_text('hello',speak=False)
        self.assertEqual(out['delivery'],'accepted');self.assertEqual(out['requestId'],'job-one')

    def test_pre_submission_rejection_can_be_recovered(self):
        class Route:
            def ask_with_receipt(self,*a,**kw):raise DeliveryError('not online','not-sent','job-two','start')
        b=VoiceBridge(StubStt(),StubTts(tmpdir()),Route(),play=lambda path:None);self.addCleanup(b.close)
        out=b.ask_text('hello',speak=False)
        self.assertEqual(out['delivery'],'not-sent');self.assertFalse(out['accepted'])

    def test_late_accepted_reply_never_emits_into_new_local_turn(self):
        replies=[]
        class Route:
            def ask_with_receipt(inner,text,is_current,images=None,on_accepted=None):
                on_accepted({'requestId':'job-old','accepted':True});b.interrupt();return 'stale answer'
        b=VoiceBridge(StubStt(),StubTts(tmpdir()),Route(),play=lambda path:None,on_reply=replies.append)
        self.addCleanup(b.close)
        out=b.ask_text('hello',speak=False)
        self.assertTrue(out['cancelled']);self.assertTrue(out['accepted']);self.assertEqual(replies,[])

if __name__=='__main__':unittest.main()
