"""A compact sea-blue/ivory pixel speech bubble. Tk stays on the UI thread."""
import time
import tkinter as tk
from tkinter import font as tkfont

from . import window as W
from .dialogue import clean_dialogue

FILL='#FCFBFF'
EDGE='#6476A2'
INNER='#DCE6F3'
INK='#343B55'
SHADOW='#C8D5E8'
PAD=16
TAIL=12

# What the user said (speech-to-text) gets its own colours and no pointer: it is not the pet talking.
PALETTES={
    'pet': {'fill':FILL,'edge':EDGE,'inner':INNER,'ink':INK,'shadow':SHADOW},
    'user':{'fill':'#EAF5F1','edge':'#4E8C80','inner':'#D2EAE3','ink':'#24433D','shadow':'#C3DDD5'},
}


def wrap_dialogue(text,measure,width,max_lines=6):
    """Fit using actual font metrics; punctuation/inline IDs are not filtered."""
    lines=[]
    for paragraph in text.split('\n'):
        line=''
        for ch in paragraph:
            if line and measure(line+ch)>width:
                cut=line.rfind(' ')
                if cut>len(line)//2:
                    lines.append(line[:cut].rstrip())
                    line=line[cut+1:]+ch
                else:
                    lines.append(line.rstrip())
                    line=ch.lstrip()
            else:
                line+=ch
            if len(lines)>max_lines:
                break
        if len(lines)>max_lines:
            break
        lines.append(line.rstrip())
    clipped=len(lines)>max_lines
    lines=lines[:max_lines]
    if clipped:
        last=lines[-1].rstrip()
        while last and measure(last+'…')>width:
            last=last[:-1]
        lines[-1]=last+'…'
    return '\n'.join(lines).strip()


def bubble_position(body,size,work,gap=10):
    """Prefer above, flip below near the top; keep the whole bubble on screen."""
    l,t,r,b=body
    w,h=size
    wl,wt,wr,wb=work
    x=(l+r-w)/2
    if t-gap-h>=wt:
        y=t-gap-h
        tail='down'
    elif b+gap+h<=wb:
        y=b+gap
        tail='up'
    else:
        y=max(wt,min(t-gap-h,wb-h))
        tail='down' if y+h<=(t+b)/2 else 'up'
    x=max(wl+6,min(x,wr-w-6)) if wr-wl>=w+12 else wl
    y=max(wt,min(y,wb-h))
    tip=max(26,min((l+r)/2-x,w-26))
    return int(round(x)),int(round(y)),tail,int(round(tip))


def stepped_rect(x0,y0,x1,y1,r=8):
    s=r//2
    return [x0+r,y0,x1-r,y0,x1-r,y0+s,x1-s,y0+s,x1-s,y0+r,
            x1,y0+r,x1,y1-r,x1-s,y1-r,x1-s,y1-s,x1-r,y1-s,
            x1-r,y1,x0+r,y1,x0+r,y1-s,x0+s,y1-s,x0+s,y1-r,
            x0,y1-r,x0,y0+r,x0+s,y0+r,x0+s,y0+s,x0+r,y0+s]


def draw_shell(canvas,w,h,tail='down',tip=None,kind='pet'):
    canvas.delete('skin')
    pal=PALETTES.get(kind,PALETTES['pet'])
    FILL,EDGE,INNER,SHADOW=pal['fill'],pal['edge'],pal['inner'],pal['shadow']
    if kind=='user':
        tail=None
    tip=w//2 if tip is None else max(26,min(tip,w-26))
    y0=2+(TAIL if tail=='up' else 0)
    y1=h-4-(TAIL if tail=='down' else 0)
    canvas.create_polygon(stepped_rect(2,y0+3,w-3,y1+3),fill=SHADOW,outline='',tags='skin')
    canvas.create_polygon(stepped_rect(2,y0,w-3,y1),fill=FILL,outline=EDGE,width=2,tags='skin')
    canvas.create_line(12,y0+3,w-13,y0+3,fill=INNER,width=2,tags='skin')
    if tail is None:
        canvas.tag_lower('skin')
        return y0
    if tail=='down':
        points=[tip-10,y1-2,tip-10,y1+4,tip-4,y1+4,tip-4,y1+9,
                tip+2,y1+9,tip+2,y1+4,tip+8,y1+4,tip+8,y1-2]
    else:
        points=[tip-10,y0+2,tip-10,y0-4,tip-4,y0-4,tip-4,y0-9,
                tip+2,y0-9,tip+2,y0-4,tip+8,y0-4,tip+8,y0+2]
    canvas.create_polygon(points,fill=FILL,outline=EDGE,width=2,tags='skin')
    # Cover the tail seam so the card and its little wave-shaped pointer join.
    seam=y1-1 if tail=='down' else y0+1
    canvas.create_line(tip-8,seam,tip+6,seam,fill=FILL,width=4,tags='skin')
    canvas.tag_lower('skin')
    return y0


class Bubble:
    """Readable, click-through bubble; no raw UI blocks, focus steal or tall JSON panels."""
    def __init__(self,pet,kind='pet'):
        self.pet=pet
        self.kind=kind if kind in PALETTES else 'pet'
        pal=PALETTES[self.kind]
        self.win=tk.Toplevel(pet.root)
        self.win,self.canvas=W.overlay(self.win,160,72,topmost=getattr(pet,'topmost',True))
        self.font=tkfont.Font(root=self.win,family='Microsoft YaHei UI',size=11)
        self.label=tk.Label(self.canvas,text='',bg=pal['fill'],fg=pal['ink'],font=self.font,
                            justify='left',anchor='w',padx=0,pady=0,bd=0)
        self.item=self.canvas.create_window(PAD,PAD,window=self.label,anchor='nw')
        self.until=0.0
        self._size=(160,72)
        self._skin_key=None
        self.full_text=''
        W.native_flags(self.win)
        W.click_through(self.win)
        self.win.withdraw()

    def _work(self):
        return self.pet.work_area()

    def show(self,text,seconds=8.0,page=False):
        """page=True: text is a page paginate_dialogue already cleaned and wrapped at this
        width; show it verbatim so what is displayed is exactly what was measured."""
        clean=str(text or '').strip('\n') if page else clean_dialogue(text)
        self.full_text=clean
        if not clean:
            self.until=0.0
            self.label.config(text='')
            self.win.withdraw()
            return
        wl,wt,wr,wb=self._work()
        width=max(48,min(280,wr-wl-2*PAD-16))
        lines=max(1,min(6,(wb-wt-2*PAD-TAIL-12)//self.font.metrics('linespace')))
        display=clean if page else wrap_dialogue(clean,self.font.measure,width,lines)
        self.label.config(text=display)
        self.win.update_idletasks()
        w=max(136,self.label.winfo_reqwidth()+2*PAD)
        h=self.label.winfo_reqheight()+2*PAD+(0 if self.kind=='user' else TAIL)+4
        self._size=(w,h)
        self.canvas.config(width=w,height=h)
        self.until=time.monotonic()+max(.5,float(seconds))
        self.follow()
        self.win.deiconify()
        W.native_flags(self.win)
        W.click_through(self.win)

    def hold(self,seconds,exact=False):
        if self.until:
            end=time.monotonic()+seconds
            self.until=end if exact else max(self.until,end)

    def follow(self):
        if not self.until:
            return
        if time.monotonic()>self.until:
            self.until=0.0
            self.win.withdraw()
            return
        body=self.pet.body_screen()
        w,h=self._size
        x,y,tail,tip=bubble_position(body,self._size,self._work())
        self.place(x,y,tail,tip)

    def place(self,x,y,tail,tip):
        w,h=self._size
        skin_key=(w,h,tail,tip)
        if skin_key!=self._skin_key:
            y0=draw_shell(self.canvas,w,h,tail,tip,self.kind)
            self.canvas.coords(self.item,PAD,y0+PAD)
            self._skin_key=skin_key
        self.win.geometry('%dx%d%+d%+d'%(w,h,x,y))

    def destroy(self):
        try:
            self.win.destroy()
        except tk.TclError:
            pass


def paginate_dialogue(text,measure,width,max_lines=6):
    """Use the renderer's exact word wrapping so no page is reflowed into an ellipsis."""
    lines=wrap_dialogue(text,measure,width,max_lines=len(text)+1).split('\n')
    return ['\n'.join(lines[i:i+max_lines]) for i in range(0,len(lines),max_lines)] if text else []


def stack_positions(body,sizes,work,gap=8):
    """Oldest to newest, with newest closest to the pet. Return only cards that fit."""
    wl,wt,wr,wb=work;l,t,r,b=body
    above=max(0,t-10-wt);below=max(0,wb-b-10)
    total=sum(h for w,h in sizes)+max(0,len(sizes)-1)*gap
    down=above>=total or above>=below
    space=above if down else below
    keep=[];used=0
    for i in range(len(sizes)-1,-1,-1):
        w,h=sizes[i]
        if used+h>space:break
        x=max(wl+6,min((l+r-w)/2,wr-w-6)) if wr-wl>=w+12 else wl
        y=t-10-used-h if down else b+10+used
        tip=max(26,min((l+r)/2-x,w-26))
        keep.append((i,int(x),int(y),'down' if down else 'up',int(tip)))
        used+=h+gap
    # A very short monitor still gets one clamped card.
    if not keep and sizes:
        i=len(sizes)-1
        keep=[(i,*bubble_position(body,sizes[i],work))]
    return list(reversed(keep))


class BubbleStack:
    MAX=3

    def __init__(self,pet):
        self.pet=pet
        self._probe=Bubble(pet)
        self.cards=[]
        self.pending=[]
        self.next_at=0.
        self._serial=0

    @property
    def windows(self):return [self._probe.win]+[c.win for c in self.cards]

    @property
    def until(self):return max((c.until for c in self.cards),default=0.)

    @property
    def label(self):return self.cards[-1].label if self.cards else self._probe.label

    def _pages(self,text):
        wl,wt,wr,wb=self.pet.work_area()
        width=max(48,min(280,wr-wl-2*PAD-16))
        lines=max(1,min(6,(wb-wt-2*PAD-TAIL-12)//self._probe.font.metrics('linespace')))
        return paginate_dialogue(clean_dialogue(text),self._probe.font.measure,width,lines)

    def show(self,text,seconds=8.,kind='pet'):
        self.pending=[]
        pages=self._pages(text)
        for page in pages:
            dwell=max(3.,min(15.,len(page)/6.))
            self.pending.append((page,max(float(seconds),dwell),dwell,kind))
        self.next_at=0.
        self.follow()

    def show_caption(self,text,seconds=0.):
        if seconds<=0:
            self.show(text,8.);return
        self.pending=[]
        pages=self._pages(text)
        duration=max(.5,float(seconds))/max(1,len(pages))
        for page in pages:self.pending.append((page,max(6.,duration+4.),duration,'pet'))
        self.next_at=0.
        self.follow()

    def hold(self,seconds,exact=False):
        if self.cards:self.cards[-1].hold(seconds,exact)

    def follow(self):
        now=time.monotonic()
        for c in self.cards[:]:
            if c.until<=now:
                c.destroy();self.cards.remove(c)
        if self.pending and now>=self.next_at:
            page,ttl,dwell,kind=self.pending.pop(0)
            c=Bubble(self.pet,kind);c.show(page,ttl,page=True);self.cards.append(c)
            self.next_at=now+dwell
        while len(self.cards)>self.MAX:self.cards.pop(0).destroy()
        if not self.cards:return
        places=stack_positions(self.pet.body_screen(),[c._size for c in self.cards],self.pet.work_area())
        visible={p[0] for p in places}
        for i,c in enumerate(self.cards):
            if i not in visible:c.win.withdraw()
        for i,x,y,tail,tip in places:
            c=self.cards[i];c.place(x,y,tail,tip);c.win.deiconify()

    def destroy(self):
        self.pending=[]
        for c in self.cards+[self._probe]:c.destroy()
        self.cards=[]
