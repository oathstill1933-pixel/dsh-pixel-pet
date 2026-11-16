"""Interruptible WAV playback, retained-cursor slices, and playback-reference echo guard."""
import os
import sys
import threading
import time
import uuid
import wave

from .tts import wav_seconds


def slice_wav(path,offset):
    """Keep original WAV untouched. Return (playable path, temporary path or None)."""
    if offset<=.005:
        return path,None
    with wave.open(path,'rb') as source:
        params=source.getparams()
        source.setpos(min(source.getnframes(),int(offset*source.getframerate())))
        data=source.readframes(source.getnframes())
    target=os.path.join(os.path.dirname(path),'resume-'+uuid.uuid4().hex+'.wav')
    with wave.open(target,'wb') as out:
        out.setparams(params)
        out.writeframes(data)
    return target,target


class PlaybackReference:
    """Subtract the best delayed copy of the exact playing PCM; preserve near-end speech.

    This is a lightweight reference echo guard, not a speaker-identity verifier.
    Missing numeric dependencies or an unreadable WAV disables automatic barge-in.

    numpy is imported on the first playback, not in the constructor: the pet is usually idle and numpy
    plus its BLAS thread pool is the largest thing it would otherwise carry all day.
    """
    def __init__(self,data_dir=None,clock=time.monotonic):
        self.clock=clock
        self._lock=threading.Lock()
        self._samples=None
        self._started=0
        self._np=None
        self._data_dir=data_dir
        self._tried=False

    def _load(self):
        """-> numpy module or None (once). Called from the playback thread only."""
        if self._np is not None or self._tried:
            return self._np
        with self._lock:
            if self._np is not None or self._tried:
                return self._np
            self._tried=True
            try:
                if self._data_dir:
                    from .mic import add_pylibs
                    add_pylibs(self._data_dir)
                import numpy as np
                self._np=np
            except ImportError:
                self._np=None
        return self._np

    @property
    def available(self):return self._np is not None or not self._tried

    @property
    def active(self):
        with self._lock:return self._samples is not None

    def start(self,path):
        np=self._load()
        if np is None:return
        try:
            with wave.open(path,'rb') as w:
                if w.getsampwidth()!=2 or w.getcomptype()!='NONE':
                    return
                rate,channels=w.getframerate(),w.getnchannels()
                a=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').astype(np.float32)
            if channels>1:a=a.reshape(-1,channels).mean(axis=1)
            if rate!=16000:
                a=np.interp(np.arange(round(len(a)*16000/rate))*rate/16000,np.arange(len(a)),a).astype(np.float32)
            with self._lock:self._samples,self._started=a,self.clock()
        except (OSError,wave.Error,ValueError):
            self.stop()

    def stop(self):
        with self._lock:self._samples=None

    def filter(self,pcm,now=None):
        np=self._np
        with self._lock:a,started=self._samples,self._started
        if np is None or a is None:return pcm
        mic=np.frombuffer(pcm[:len(pcm)//2*2],dtype='<i2').astype(np.float32)
        n=len(mic)
        if not n:return pcm
        mic-=mic.mean()
        energy=float(mic@mic)
        if energy<1:return b'\0'*(n*2)
        elapsed=(self.clock() if now is None else now)-started
        # Search the preceding 800 ms: output-device buffering and room echo vary.
        end=min(len(a),max(n,int((elapsed+.04)*16000)))
        begin=max(0,end-n-12800)
        ref=a[begin:end]
        if len(ref)<n:return pcm
        size=1<<(len(ref)+n-2).bit_length()
        dots=np.fft.irfft(np.fft.rfft(ref,size)*np.fft.rfft(mic[::-1],size),size)[n-1:len(ref)]
        squares=np.concatenate(([0.],np.cumsum(ref.astype(np.float64)**2)))
        energies=np.maximum(1.,squares[n:]-squares[:-n])
        scores=np.abs(dots)/np.sqrt(energies*energy)
        k=int(np.argmax(scores))
        if scores[k]<.52:return pcm
        gain=float(dots[k]/energies[k])
        residual=mic-gain*ref[k:k+n]
        # Near-pure echo is silence; mixed human+echo retains its residual.
        if float(residual@residual)<energy*.08:
            return b'\0'*(n*2)
        return np.clip(residual,-32768,32767).astype('<i2').tobytes()


class Player:
    def __init__(self,data_dir=None):
        self.reference=PlaybackReference(data_dir)
        self._play_lock=threading.Lock()
        self._control=threading.Lock()
        self._active_stop=None
        self.generation=0

    def play(self,path,expected=None):
        with self._play_lock:
            stop=threading.Event()
            with self._control:
                if expected is not None and expected!=self.generation:return
                self._active_stop=stop
                self.reference.start(path)
                if os.name=='nt':
                    import winsound
                    winsound.PlaySound(path,winsound.SND_FILENAME|winsound.SND_ASYNC|winsound.SND_NODEFAULT)
            try:
                end=time.monotonic()+wav_seconds(path)+.05
                while time.monotonic()<end:
                    if stop.wait(.02):break
            finally:
                with self._control:
                    if self._active_stop is stop:
                        self._active_stop=None
                        self.reference.stop()
                        if stop.is_set() and os.name=='nt':
                            import winsound
                            winsound.PlaySound(None,0)

    def stop(self):
        with self._control:
            self.generation+=1
            if self._active_stop:self._active_stop.set()
            if os.name=='nt':
                import winsound
                winsound.PlaySound(None,0)
