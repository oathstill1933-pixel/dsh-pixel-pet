"""Portable interruption policy. No speaker prints and no private service routes."""
import difflib
import re

DEFAULT_INTERRUPT={'enabled':True,'reply':'嗯，你说'}
FOLLOWUP_WAIT=6.0
# After the acknowledgement finishes, let the room echo die before the follow-up mic opens.
ACK_TAIL=.6
# A transcript this similar to some window of what we just played is our own echo.
# .75 tolerates one STT homophone slip per four characters (公园散步 -> 公园散布).
ECHO_RATIO=.75


def interrupt_cfg(value):
    value=value if isinstance(value,dict) else {}
    enabled=value.get('enabled',True)
    reply=value.get('reply','嗯，你说')
    return {'enabled':enabled if isinstance(enabled,bool) else True,
            'reply':reply.strip()[:120] if isinstance(reply,str) else '嗯，你说'}


def normal_words(text):
    return ''.join(re.findall(r'[\w一-鿿]',str(text or '').lower()))


def _best_window(a,b):
    """Highest SequenceMatcher ratio of `a` against any window of `b` of length len(a)-1..len(a)+1."""
    n=len(a)
    if len(b)<=n+1:
        return difflib.SequenceMatcher(None,a,b,autojunk=False).ratio()
    best=0.
    m=difflib.SequenceMatcher(None,autojunk=False)
    m.set_seq2(a)
    chars=set(a)
    for size in (n-1,n,n+1):
        if size<1:continue
        for i in range(len(b)-size+1):
            w=b[i:i+size]
            # Cheap upper bound before the full diff: shared characters only.
            if 2*sum(1 for c in w if c in chars)/(n+size)<max(best,ECHO_RATIO):continue
            m.set_seq1(w)
            r=m.ratio()
            if r>best:
                best=r
                if best>=.999:return best
    return best


def is_playback_transcript(heard,spoken,*context):
    """Second guard after acoustic echo subtraction; don't answer our own caption.

    `spoken` (and any extra `context`) may be strings or lists of strings: the current
    sentence, its neighbours and the acknowledgement. A short echo fragment is matched
    against its best window in each, and also in their concatenation so a fragment
    straddling a sentence boundary still counts.
    """
    a=normal_words(heard)
    if not a:
        return True
    texts=[]
    for item in (spoken,)+context:
        if isinstance(item,(list,tuple)):texts.extend(item)
        else:texts.append(item)
    parts=[normal_words(t) for t in texts if t]
    parts=[p for p in parts if p]
    if not parts:
        return False
    if len(parts)>1:parts.append(''.join(parts))
    for b in parts:
        if len(a)>=2 and a in b:
            return True
        if len(a)>=4 and _best_window(a,b)>=ECHO_RATIO:
            return True
    return False


def continuation_prompt(heard,completed,current,offset,pending):
    context=('[语音打断上下文：上一轮朗读被用户打断。已完整播完的尾部：'+completed[-140:]+
             '；被打断的当前句：'+current[:160]+f'（约播放 {offset:.1f} 秒，非逐字边界）；'+
             '未播的后续：'+pending[:160]+'。请衔接用户的新问题，不要把未播内容当成用户已经听过。]\n')
    return context+heard[:max(0,2000-len(context))]
