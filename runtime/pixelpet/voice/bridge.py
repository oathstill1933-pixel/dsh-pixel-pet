"""One voice turn at a time; sentence captions and a retained-WAV interruption handshake."""
import os
import queue
import threading
import time
from types import SimpleNamespace

from . import RouteUnset,VoiceError
from ..dialogue import clean_dialogue
from .tts import DEFAULT_VOICE,split_sentences,wav_seconds
from .playback import Player,slice_wav
from .interruption import ACK_TAIL,FOLLOWUP_WAIT,continuation_prompt,interrupt_cfg,is_playback_transcript

STATES=('idle','listening','thinking','speaking')
# Preparation can include a cold synth or waiting for an in-flight sentence's synth lock.
# Do not spend the short playback watchdog while the new editable line is still being prepared.
ACK_PREP_SECONDS=90.
ACK_PLAY_SECONDS=12.
ACK_CACHE_LIMIT=8


class _ProgressSpeech:
    """Bounded, request-local playback; polling never waits for TTS in its callback."""
    def __init__(self, bridge, turn, speak):
        self.bridge,self.turn,self.speak=bridge,turn,speak
        self.items=queue.Queue(maxsize=8)
        self.closed=threading.Event()
        self.discard=False
        self.last_text=''
        self.last_enqueued_text=''
        self.last_seq=0
        self.thread=None
        if speak:
            self.thread=threading.Thread(target=self._run,daemon=True)
            self.thread.start()

    def add(self, update):
        b=self.bridge
        if b._turn!=self.turn or self.closed.is_set() or not isinstance(update,dict):return
        seq=update.get('seq')
        if type(seq) is not int or seq<=self.last_seq:return
        self.last_seq=seq
        text=clean_dialogue(update.get('text') or '')
        if not text or text==self.last_enqueued_text:return
        self.last_enqueued_text=text
        if not self.speak:
            self.last_text=text
            if b._turn==self.turn:b._emit_for(self.turn,b.on_caption,text,0.)
            return
        try:self.items.put_nowait(text)
        except queue.Full:
            try:self.items.get_nowait()
            except queue.Empty:pass
            if b._turn==self.turn:b.progress_dropped+=1
            try:self.items.put_nowait(text)
            except queue.Full:pass

    def _run(self):
        b=self.bridge
        while b._turn==self.turn:
            if self.closed.is_set() and (self.discard or self.items.empty()):return
            try:text=self.items.get(timeout=.1)
            except queue.Empty:continue
            if self.discard or b._turn!=self.turn:return
            self.last_text=text  # attempted/partially played paragraphs are never auto-replayed as final
            b._emit_for(self.turn,b.on_reply,text)
            try:out=b._speak(text,self.turn,progress=True)
            except Exception as exc:
                if b._turn!=self.turn:return
                b.last_progress_error=b._describe(exc)
                b._emit_for(self.turn,b.on_caption,'过程播报失败：'+b.last_progress_error[:180],6.)
                b._set('thinking',self.turn)
                continue
            if out.get('cancelled'):return

    def finish(self, discard=False):
        self.discard=discard
        self.closed.set()
        if self.thread:
            while self.thread.is_alive() and self.bridge._turn==self.turn:self.thread.join(.1)


class VoiceBridge:
    def __init__(self,stt,tts,llm,voice=DEFAULT_VOICE,play=None,stop=None,on_state=None,on_reply=None,
                 on_speak=None,on_heard=None,on_caption=None,interruption=None,data_dir=None,
                 clock=time.monotonic,on_barge_rearm=None,sv=None):
        self.stt,self.tts,self.llm=stt,tts,llm
        self.voice=voice
        self.player=None
        if play is None:
            self.player=Player(data_dir)
            play,stop=self.player.play,self.player.stop
        self.play,self.stop_play=play,stop or (lambda:None)
        self.on_state,self.on_reply=on_state,on_reply
        self.on_speak,self.on_heard,self.on_caption=on_speak,on_heard,on_caption
        # Reset the barge detector: a new sentence starts, or a probe turned out to be echo.
        self.on_barge_rearm=on_barge_rearm
        self.state='idle'
        self.last_error=self.last_interrupt_error=None
        self.last_delivery=None
        self.last_progress_error=None
        self.progress_dropped=0
        self._turn=0
        self._lock=threading.RLock()
        self._cv=threading.Condition(self._lock)
        self._audio_lock=threading.Lock()
        self._synth_lock=threading.Lock()
        self._audio_idle=threading.Event();self._audio_idle.set()
        self._speech=None
        self._interrupt=interrupt_cfg(interruption)
        self._monitor_listening=False
        self._ack_cache={}
        self._probe_busy=False
        self._last_probe=-10.
        self.clock=clock
        # 声纹闸：None = 没启用；有对象就要求它提供 verify(pcm, rate, mode) -> {ok, reason, ...}
        # 这是「只和录入过的人说话」的唯一出口，任何异常一律按拒绝处理（fail-closed）。
        self.sv=sv

    def _gate(self,pcm,rate,mode):
        """-> None 表示放行；否则 {'rejected':True,'reason':...}。

        所有调用点都在「进 STT / 切 thinking / 打断」之前，所以拒绝既不消耗 STT，
        也不会取消正在进行的回合。校验器抛异常同样按拒绝处理。
        """
        vp=getattr(self,'sv',None)
        if vp is None:return None
        try:out=vp.verify(pcm,rate,mode)
        except Exception:return {'rejected':True,'reason':'model-error'}
        if isinstance(out,dict):
            if out.get('ok') is True:return None
            return {'rejected':True,'reason':str(out.get('reason') or 'strict')}
        return {'rejected':True,'reason':'model-error'}

    def _set(self,state,turn=None):
        with self._cv:
            if turn is not None and turn!=self._turn:return False
            if state==self.state:return True
            self.state=state
        self._emit(self.on_state,state)
        return True

    @staticmethod
    def _emit(fn,*args):
        if fn:
            try:fn(*args)
            except Exception:pass

    def _emit_for(self,turn,fn,*args):
        # UI callbacks capture the epoch while it is still owned, then recheck on the Tk thread.
        with self._cv:
            if turn==self._turn:self._emit(fn,*args)

    def _owns(self,s):
        return self._speech is s and s.turn==self._turn and not s.cancelled

    def _begin(self):
        with self._cv:
            self._turn+=1
            self.last_error=None
            self.last_delivery=None
            self.last_progress_error=None
            self.progress_dropped=0
            if self._speech:self._speech.cancelled=True
            self._speech=None
            self._probe_busy=False
            self._cv.notify_all()
            return self._turn

    @property
    def interruption_phase(self):
        with self._cv:
            if self._speech and self._speech.paused:return self._speech.phase
            return 'verifying' if self._probe_busy else ''

    @property
    def can_barge_monitor(self):
        return bool(self._monitor_listening and self._interrupt['enabled'] and self.player and
                    self.player.reference.active and not self.interruption_phase)

    def filter_microphone(self,pcm):
        return self.player.reference.filter(pcm) if self.player else pcm

    def configure_interrupt(self,value):
        with self._cv:self._interrupt=interrupt_cfg(value)
        if not self._interrupt['enabled']:self.resume_interrupted()

    def set_barge_listening(self,on):
        self._monitor_listening=bool(on)
        if not on:self.resume_interrupted()

    def status(self):
        with self._cv:
            s=self._speech
            return {'state':self.state,'voice':self.voice,'stt':getattr(self.stt,'name','?'),
                    'tts':getattr(self.tts,'name','?'),'llm':getattr(self.llm,'name','?'),
                    'lastError':self.last_error,'lastInterruptError':self.last_interrupt_error,
                    'interruption':dict(self._interrupt),
                    'interruptStage':getattr(s,'ack_stage',None) if s and s.paused and s.phase=='ack' else None,
                    'routeWaiting':bool(getattr(self.llm,'waiting',0)),
                    'routeProtocol':1 if hasattr(self.llm,'ask_with_receipt') else 0,
                    'lastDelivery':dict(self.last_delivery) if self.last_delivery else None,
                    'progressProtocol':1 if hasattr(self.llm,'ask_with_updates') else 0,
                    'progressSpeaking':bool(s and self._owns(s) and getattr(s,'progress',False) and self.state=='speaking'),
                    'lastProgressError':self.last_progress_error,'progressDropped':self.progress_dropped,
                    'interruptPhase':self.interruption_phase,'interruptReady':bool(self.player and self.player.reference.available),
                    'queuedSentences':max(0,len(s.parts)-s.index-1) if s else 0,
                    'offsetSeconds':round(s.offset,2) if s else 0,
                    'voiceprint':(self.sv.summary() if self.sv is not None and hasattr(self.sv,'summary') else None)}

    def listen(self):
        self._begin();self.stop_play();self._set('listening')

    def interrupt(self):
        self._begin();self.stop_play();self._set('idle')

    def close(self):
        self.interrupt()
        for part in (self.tts,self.stt):
            try:part.close()
            except Exception:pass

    def hear(self,pcm,sample_rate=16000,images=None,speak=True,on_accepted=None):
        denied=self._gate(pcm,sample_rate,'strict')
        if denied:
            # 不认识的说话人：直接丢弃这段，不切 thinking、不进 STT、不影响现有回合
            return {'rejected':True,'reason':denied['reason'],'heard':''}
        turn=self._turn if self.state=='listening' else self._begin()
        if not self._set('thinking',turn):return {'cancelled':True}
        try:text=self.stt.transcribe(pcm,sample_rate)
        except Exception as exc:return self._fail(exc,turn,delivery='not-sent',accepted=False,stage='stt')
        if turn!=self._turn:return {'cancelled':True,'heard':text,'delivery':'not-sent','accepted':False}
        if not text:
            self._set('idle',turn);return {'heard':''}
        self._emit(self.on_heard,text)
        out=self._answer(text,turn,images,speak,on_accepted);out['heard']=text
        return out

    def ask_text(self,text,images=None,speak=True,on_accepted=None):
        turn=self._begin();self.stop_play();self._set('thinking',turn)
        out=self._answer(str(text or '').strip(),turn,images,speak,on_accepted);out['heard']=text
        return out

    def speak(self,text,expected_turn=None):
        # A delayed failure-notification worker must not cancel a newer user turn.
        with self._cv:
            if expected_turn is not None and expected_turn!=self._turn:
                return {'cancelled':True,'turn':expected_turn}
            turn=self._begin();self.stop_play()
        out=self._speak(str(text or ''),turn)
        out['turn']=turn
        return out

    def speak_if_current(self,text,expected_turn):
        """An asynchronous notification may speak only while its originating turn still owns the bridge."""
        return self.speak(text,expected_turn=expected_turn)

    def _answer(self,text,turn,images=None,speak=True,on_accepted=None):
        stream_route=hasattr(self.llm,'ask_with_updates')
        receipt_route=stream_route or hasattr(self.llm,'ask_with_receipt')
        progress=_ProgressSpeech(self,turn,speak) if stream_route else None
        facts={'delivery':'not-sent' if receipt_route else 'unknown','accepted':False,'requestId':None}
        def remember():
            with self._cv:
                if turn==self._turn:self.last_delivery=dict(facts)
        def accepted(receipt):
            facts.update(delivery='accepted',accepted=True,requestId=receipt.get('requestId') if isinstance(receipt,dict) else None)
            remember()
            self._emit(on_accepted,dict(facts))
        try:
            if stream_route:
                reply=self.llm.ask_with_updates(text,lambda:turn==self._turn,
                    images=list(images) if images else None,on_accepted=accepted,on_update=progress.add)
            elif receipt_route:
                reply=self.llm.ask_with_receipt(text,lambda:turn==self._turn,
                    images=list(images) if images else None,on_accepted=accepted)
            elif hasattr(self.llm,'ask_if_current'):
                reply=self.llm.ask_if_current(text,lambda:turn==self._turn,images=list(images) if images else None)
            else:
                reply=self.llm.ask(text,images=list(images)) if images else self.llm.ask(text)
        except Exception as exc:
            if progress:progress.finish(discard=True)
            delivery='accepted' if facts['accepted'] else getattr(exc,'delivery','not-sent' if isinstance(exc,RouteUnset) else 'unknown')
            if delivery not in ('not-sent','unknown','accepted'):delivery='unknown'
            facts.update(delivery=delivery,accepted=delivery=='accepted',requestId=getattr(exc,'request_id',None) or facts['requestId'])
            remember()
            return self._fail(exc,turn,**facts,stage=getattr(exc,'stage','reply'))
        if progress:progress.finish()
        if turn!=self._turn:return {'cancelled':True,'reply':reply,**facts}
        # A legacy LLM's successful answer also proves submission; speech failure cannot undo it.
        if not facts['accepted'] and (reply or not receipt_route):accepted({})
        remember()
        if reply:self._emit_for(turn,self.on_reply,clean_dialogue(reply))
        already_streamed=bool(progress and progress.last_text==clean_dialogue(reply))
        if not reply or not speak or already_streamed:
            if reply and not already_streamed:self._emit_for(turn,self.on_caption,clean_dialogue(reply),0.)
            self.last_error=None;self._set('idle',turn)
            return {'reply':reply or '',**facts,'streamed':already_streamed}
        out=self._speak(reply,turn);out.update(reply=reply,**facts)
        return out

    def _synth(self,text):
        with self._synth_lock:return self.tts.synthesize(text,self.voice)

    def _ack_file(self,text):
        key=(self.voice,text)
        with self._synth_lock:
            path=self._ack_cache.get(key)
            # The general TTS cache prunes old WAVs. A remembered path is not a live audio asset.
            if not path or not os.path.isfile(path) or wav_seconds(path)<=0:
                self._ack_cache.pop(key,None)
                path=self.tts.synthesize(text,self.voice)
                if not path or not os.path.isfile(path) or wav_seconds(path)<=0:
                    raise VoiceError('打断回应没有生成可播放的音频')
                self._ack_cache[key]=path
            else:
                # Recently used acknowledgements should not be the oldest generic cache entry.
                try:os.utime(path,None)
                except OSError:pass
                self._ack_cache.pop(key,None);self._ack_cache[key]=path
            while len(self._ack_cache)>ACK_CACHE_LIMIT:
                self._ack_cache.pop(next(iter(self._ack_cache)))
            return path

    def _echo_context(self,s):
        """What the mic may be hearing back: neighbouring sentences and the acknowledgement."""
        i=s.index
        return [s.parts[i-1] if 0<i<=len(s.parts) else '',s.current,
                s.parts[i+1] if i+1<len(s.parts) else '',
                clean_dialogue(getattr(s,'ack_reply','')),clean_dialogue(self._interrupt['reply'])]

    def _cancelled(self,s,wavs):
        return {'cancelled':True,'interrupted':bool(s.superseded),'wavs':wavs}

    def _speak(self,text,turn,progress=False):
        resume='thinking' if progress else 'idle'
        def fail(exc,**extra):
            if not progress:return self._fail(exc,turn,**extra)
            if turn!=self._turn:return {'cancelled':True,**extra}
            self.last_progress_error=self._describe(exc)
            self._emit_for(turn,self.on_caption,'过程播报失败：'+self.last_progress_error[:180],6.)
            self._set(resume,turn)
            return {'error':self.last_progress_error,**extra}
        parts=split_sentences(clean_dialogue(text))
        if not parts:
            if not progress:self.last_error=None
            self._set(resume,turn);return {'wavs':[]}
        s=SimpleNamespace(turn=turn,parts=parts,index=0,current='',offset=0.,duration=0.,started=0.,
                          paused=False,phase='playing',pause_seq=0,deadline=0.,utterance_at=None,
                          cancelled=False,superseded=False,phase_at=0.,progress=progress)
        with self._cv:
            if turn!=self._turn:return {'cancelled':True}
            self._speech=s
        q=queue.Queue(maxsize=2)

        def put(item):
            while self._owns(s):
                try:q.put(item,timeout=.1);return True
                except queue.Full:pass
            return False

        def produce():
            for i,part in enumerate(parts):
                with self._cv:
                    while self._owns(s) and s.paused:self._cv.wait(.1)
                    if not self._owns(s):return
                try:wav=self._synth(part)
                except Exception as exc:put(('err',exc));return
                if not put(('wav',i,part,wav)):return
                # Warm only after first actual speech, and only if the mic is open.
                if i==0 and self._monitor_listening and self._interrupt['enabled'] and self._interrupt['reply']:
                    try:self._ack_file(clean_dialogue(self._interrupt['reply']))
                    except Exception:pass
            put(('end',))
        threading.Thread(target=produce,daemon=True).start()
        wavs=[];error=None
        try:
            while self._owns(s):
                try:item=q.get(timeout=.1)
                except queue.Empty:continue
                if not self._owns(s):return self._cancelled(s,wavs)
                if item[0]=='end':break
                if item[0]=='err':
                    if not wavs:
                        self._emit_for(turn,self.on_caption,clean_dialogue(text),0.)
                        return fail(item[1])
                    error=item[1];break
                _,i,sentence,wav=item
                with self._cv:
                    s.index,s.current,s.offset,s.duration=i,sentence,0.,wav_seconds(wav)
                while self._owns(s):
                    with self._cv:
                        while self._owns(s) and s.paused:
                            self._cv.wait(.05);self.tick_interrupt()
                        if not self._owns(s):return self._cancelled(s,wavs)
                        seq=s.pause_seq
                    playable,temporary=slice_wav(wav,s.offset)
                    try:
                        with self._audio_lock:
                            with self._cv:
                                if not self._owns(s):return self._cancelled(s,wavs)
                                if s.paused:continue
                                s.started=self.clock();self._audio_idle.clear()
                                generation=self.player.generation if self.player else None
                            if not self._set('speaking',turn):return self._cancelled(s,wavs)
                            self._emit(self.on_barge_rearm)
                            self._emit_for(turn,self.on_caption,sentence,max(0.,s.duration-s.offset))
                            self._emit_for(turn,self.on_speak,i,sentence,max(0.,s.duration-s.offset))
                            if self.player:self.player.play(playable,expected=generation)
                            else:self.play(playable)
                    except Exception as exc:return fail(exc,wav=wav,wavs=wavs)
                    finally:
                        self._audio_idle.set()
                        if temporary:
                            try:os.remove(temporary)
                            except OSError:pass
                    with self._cv:
                        s.started=0.
                        if not self._owns(s):return self._cancelled(s,wavs)
                        if seq!=s.pause_seq:continue
                        break
                wavs.append(wav)
            if not self._owns(s):return self._cancelled(s,wavs)
            self._set(resume,turn)
            described=self._describe(error) if error else None
            if progress:self.last_progress_error=described
            else:self.last_error=described
            out={'wav':wavs[0] if wavs else None,'wavs':wavs,'sentences':len(parts)}
            if error:out['error']=described
            return out
        finally:
            with self._cv:
                if self._speech is s:self._speech=None
                self._cv.notify_all()

    def request_interrupt(self,pcm,sample_rate=16000):
        """Confirm a sustained near-end voice before pausing; stale STT cannot stop a new turn."""
        with self._cv:
            s=self._speech
            if not s or not self._owns(s) or s.paused or not self._interrupt['enabled'] or self._probe_busy:
                return False
            if self.clock()-self._last_probe<1.:return False
            self._last_probe=self.clock();self._probe_busy=True
            spoken=self._echo_context(s)
        def verify():
            paused=False
            try:
                denied=self._gate(pcm,sample_rate,'loose')
                if denied:
                    # 不像近端的人在说（或像是桌宠自己）→ 不打断，交给下面的 rearm 重新等
                    return
                heard=self.stt.transcribe(pcm,sample_rate)
                if heard and not is_playback_transcript(heard,spoken):paused=self._pause_for_interrupt(s)
            except Exception:pass
            finally:
                with self._cv:
                    owned=self._owns(s)
                    if owned:self._probe_busy=False
                # Echo or noise: let the detector listen afresh instead of waiting for a new epoch.
                if owned and not paused:self._emit(self.on_barge_rearm)
        threading.Thread(target=verify,daemon=True).start()
        return True

    def _pause_for_interrupt(self,s):
        with self._cv:
            if not self._owns(s) or s.paused or not self._interrupt['enabled']:return False
            s.paused=True;s.phase='ack';s.phase_at=self.clock();s.pause_seq+=1
            s.ack_stage='preparing';s.ack_timeout=ACK_PREP_SECONDS
            s.ack_reply=clean_dialogue(self._interrupt['reply'])
            seq=s.pause_seq;reply=s.ack_reply
            self.last_interrupt_error=None
            if s.started:
                s.offset=min(max(0.,s.duration-.05),s.offset+max(0.,self.clock()-s.started-.20))
            # Stop only while this pause still owns the bridge; a newer turn cannot slip in here.
            self.stop_play()
            self._cv.notify_all()
        threading.Thread(target=self._acknowledge,args=(s,seq,reply),daemon=True).start()
        return True

    def _owns_ack(self,s,seq):
        return self._owns(s) and s.paused and s.phase=='ack' and s.pause_seq==seq

    def _ack_error(self,s,seq,message):
        with self._cv:
            if not self._owns_ack(s,seq):return False
            self.last_interrupt_error=message
        self._emit(self.on_caption,'打断回应未能播放：'+message[:180],6.)
        return True

    def _acknowledge(self,s,seq=None,reply=None):
        # Bind to this particular pause as well as the turn: one speech can be paused again.
        seq=s.pause_seq if seq is None else seq
        reply=(getattr(s,'ack_reply',clean_dialogue(self._interrupt['reply'])) if reply is None else reply)
        self._audio_idle.wait(2.)
        try:
            if reply and self._owns_ack(s,seq):
                wav=self._ack_file(reply)
                with self._audio_lock:
                    with self._cv:
                        if not self._owns_ack(s,seq):return
                        # Start a fresh playback budget only after synthesis and lock waiting finish.
                        s.ack_stage='playing';s.phase_at=self.clock()
                        s.ack_timeout=max(ACK_PLAY_SECONDS,wav_seconds(wav)+3.)
                        generation=self.player.generation if self.player else None
                        self._audio_idle.clear();self._set('speaking',s.turn)
                    self._emit(self.on_caption,reply,max(6.,wav_seconds(wav)+1.))
                    try:
                        if self.player:self.player.play(wav,expected=generation)
                        else:self.play(wav)
                    finally:self._audio_idle.set()
        except Exception as exc:self._ack_error(s,seq,self._describe(exc))
        # Playback has returned; also wait out the reference and the room tail so the
        # acknowledgement is not heard back as the follow-up. Interruptible by stop/settings.
        ref=getattr(self.player,'reference',None)
        end=self.clock()+1.5
        with self._cv:
            while ref is not None and ref.active and self.clock()<end and self._owns_ack(s,seq):
                self._cv.wait(.05)
            if not self._owns_ack(s,seq):return
            self._cv.wait(ACK_TAIL)
            if not self._owns_ack(s,seq):return
            s.phase='waiting';s.ack_stage=None
            s.deadline=self.clock()+FOLLOWUP_WAIT;s.utterance_at=None
            self._set('listening',s.turn)

    def note_followup_started(self):
        with self._cv:
            s=self._speech
            if s and self._owns(s) and s.phase=='waiting' and s.utterance_at is None:
                s.utterance_at=self.clock()

    def drop_followup(self):
        with self._cv:
            if self._speech:self._speech.utterance_at=None
        self.tick_interrupt()

    def resume_interrupted(self,expected_speech=None,expected_seq=None,expected_phase=None,expected_phase_at=None):
        with self._cv:
            s=self._speech
            if not s or not self._owns(s) or not s.paused:return False
            if expected_speech is not None and s is not expected_speech:return False
            if expected_seq is not None and s.pause_seq!=expected_seq:return False
            if expected_phase is not None and s.phase!=expected_phase:return False
            if expected_phase_at is not None and s.phase_at!=expected_phase_at:return False
            was_ack=s.phase=='ack'
            s.paused=False;s.phase='playing';s.utterance_at=None;s.started=0.
            self._last_probe=self.clock()+.8
            if was_ack:self.stop_play()
            self._cv.notify_all()
            self._set('speaking',s.turn)
        return True

    def tick_interrupt(self):
        ack_timeout=False;stop_ack=False;note=''
        with self._cv:
            s=self._speech
            if not s or not self._owns(s) or not s.paused:return
            now=self.clock()
            if s.phase=='ack':
                stage=getattr(s,'ack_stage','preparing')
                budget=ACK_PREP_SECONDS if stage=='preparing' else getattr(s,'ack_timeout',ACK_PLAY_SECONDS)
                if now-s.phase_at<budget:return
                note=('准备打断回应超时，已跳过提示音。' if stage=='preparing' else
                      '打断回应播放超时，已停止提示音。')
                self.last_interrupt_error=note
                stop_ack=stage!='preparing';ack_timeout=True;seq=s.pause_seq
                # Keep the original speech paused and listen, rather than swallowing the user's stop.
                s.phase='waiting';s.ack_stage=None
                s.deadline=now+FOLLOWUP_WAIT;s.utterance_at=None
            resume_seq=s.pause_seq;resume_phase=s.phase;resume_phase_at=s.phase_at
            expired=(s.phase=='checking' and now-s.phase_at>=30.) or (
                s.phase=='waiting' and now>=s.deadline and
                (s.utterance_at is None or now-s.utterance_at>=30.))
        if ack_timeout:
            with self._cv:
                if not self._owns(s) or s.pause_seq!=seq or s.phase!='waiting':return
                if stop_ack:self.stop_play()
                self._emit(self.on_caption,note,6.)
                self._set('listening',s.turn)
        elif expired:self.resume_interrupted(expected_speech=s,expected_seq=resume_seq,
                                              expected_phase=resume_phase,expected_phase_at=resume_phase_at)

    def hear_followup(self,pcm,sample_rate=16000,images=None,speak=True,on_accepted=None):
        denied=self._gate(pcm,sample_rate,'strict')
        with self._cv:
            s=self._speech
            if not s or not self._owns(s) or s.phase!='waiting':return {'cancelled':True}
            if denied:
                # 追问没通过：回到等待态继续听，不算一次追问，也不推进回合
                s.phase='waiting';s.utterance_at=None
                resumed=not s.paused
            else:
                s.phase='checking';s.phase_at=self.clock()
        if denied:
            self.tick_interrupt()
            return {'heard':'','resumed':resumed,'rejected':True,'reason':denied['reason']}
        try:heard=self.stt.transcribe(pcm,sample_rate)
        except Exception as exc:
            heard='';self.last_interrupt_error=self._describe(exc)
        with self._cv:
            if not self._owns(s) or s.phase!='checking':return {'cancelled':True}
            if not heard or is_playback_transcript(heard,self._echo_context(s)):
                s.phase='waiting';s.utterance_at=None
                self.tick_interrupt()
                return {'heard':'','resumed':not s.paused}
            prompt=continuation_prompt(heard,''.join(s.parts[:s.index]),s.current,s.offset,
                                       ''.join(s.parts[s.index+1:]))
            s.superseded=True
            turn=self._begin()
        self.stop_play();self._emit(self.on_heard,heard);self._set('thinking',turn)
        out=self._answer(prompt,turn,images,speak,on_accepted);out['heard']=heard
        return out

    @staticmethod
    def _describe(exc):
        return str(exc) if isinstance(exc,VoiceError) else '%s: %s'%(type(exc).__name__,exc)

    def _fail(self,exc,turn,**extra):
        if turn!=self._turn:return {'cancelled':True,**extra}
        self.last_error=self._describe(exc);self._set('idle',turn)
        return {'error':self.last_error,**extra}

    def clone(self,ref_audio,name=None,text=None):return self.tts.clone(ref_audio,name,text)
