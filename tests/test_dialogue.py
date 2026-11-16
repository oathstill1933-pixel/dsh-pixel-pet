"""User-visible regressions: DSH cards never leak into bubble/TTS, prose survives."""
import os
import sys
import time
import unittest

sys.path.insert(0,os.path.join(os.path.dirname(os.path.dirname(__file__)),'runtime'))
from pixelpet.dialogue import clean_dialogue
from pixelpet.bubble import Bubble,bubble_position,wrap_dialogue
from pixelpet.voice.bridge import VoiceBridge

CARD='''她睡着了，我先把能用在她身上的操作都列出来：

```dsh-ui
{"title":"捉宠工具能做的","gap":12,"items":[{"type":"list","items":[{"title":"说话","desc":"冒气泡，可选本机 TTS 出声"}]}]}
```
叫醒她的时候再喊我。'''


class Dialogue(unittest.TestCase):
    def test_screenshot_card_keeps_only_prose(self):
        self.assertEqual(clean_dialogue(CARD),'她睡着了，我先把能用在她身上的操作都列出来：\n\n叫醒她的时候再喊我。')

    def test_unclosed_fences_filtered_before_any_truncation(self):
        for fence in ('```dsh-ui','~~~json'):
            with self.subTest(fence=fence):
                self.assertEqual(clean_dialogue('在呢。\n'+fence+'\n'+('"items":[], '*100)), '在呢。')

    def test_lone_fence_is_plain_text(self):
        # only a closed fence is a code block; a single ``` must not swallow the rest of the reply
        self.assertEqual(clean_dialogue('用 ``` 包住代码，然后后面的话都没了'),'用 ``` 包住代码，然后后面的话都没了')
        self.assertEqual(clean_dialogue('先看这段：\n```python\nprint(1)\n后面还有话'),'先看这段：\n```python\nprint(1)\n后面还有话')
        self.assertEqual(clean_dialogue('前 ```x``` 后，再来一个 ``` 没关'),'前\n后，再来一个 ``` 没关')

    def test_emphasis_never_eats_code_or_math(self):
        for raw in ('看 __init__.py 和 my_var__x','2 * 3 * 4 = 24','把 *args 和 **kwargs 传进去','__init__ 和 __main__',
                    'a*b*c','snake_case_name','x ** 2 + y ** 2'):
            with self.subTest(raw=raw):
                self.assertEqual(clean_dialogue(raw),raw)
        self.assertEqual(clean_dialogue('这是**重点**内容，*斜体*，~~删掉~~，__下划线强调__'),'这是重点内容，斜体，删掉，下划线强调')
        self.assertEqual(clean_dialogue('另外 `__init__.py` 里的 **导出** 也补上了'),'另外 __init__.py 里的 导出 也补上了')

    def test_inline_and_multiple_code_blocks(self):
        self.assertEqual(clean_dialogue('好了```json\n{"x":1}```，接着聊。\n~~~python\nprint(1)\n~~~'),'好了\n，接着聊。')

    def test_bare_known_payload_and_trailing_prose(self):
        self.assertEqual(clean_dialogue('在呢。\ndsh-ui\n{"title":"卡","items":[],"gap":12}\n晚安。'),'在呢。\n\n晚安。')
        self.assertEqual(clean_dialogue('{"type":"list","items":[{"title":"a"}]}'),'')
        self.assertEqual(clean_dialogue('{"tool_calls":[{"function":{"name":"move"}}]}'),'')

    def test_cutoff_bare_card(self):
        self.assertEqual(clean_dialogue('晚安。\ndsh-ui\n{"title":"工具", "items": [{"type":"list",'),'晚安。')

    def test_reasoning_and_tool_tags(self):
        self.assertEqual(clean_dialogue('<think>内部过程</think>你好。<tool_call>{"x":1}</tool_call>'),'你好。')
        self.assertEqual(clean_dialogue('在呢。<analysis>未闭合的内部过程'),'在呢。')
        self.assertEqual(clean_dialogue('<|im_start|>你好。<|im_end|>'),'你好。')

    def test_normal_text_is_not_a_blacklist(self):
        text='价格 12.5 元，温度 -3℃。pet_move / sleep / wake；集合 {a,b}，数组 [1,2,3]。🐳'
        self.assertEqual(clean_dialogue(text),text)
        self.assertEqual(clean_dialogue('JSON 参数 {"x":1} 和 A < B 都正常。'),'JSON 参数 {"x":1} 和 A < B 都正常。')

    def test_light_markdown_keeps_labels(self):
        self.assertEqual(clean_dialogue('## 早安\n- **你好**，`pet_move`。\n[说明](https://example.test) ![图](x.png)'),
                         '早安\n你好，pet_move。\n说明')

    def test_empty_machine_reply_and_idempotence(self):
        for text in ('',None,'```dsh-ui\n{"title":"a","items":[]}\n```',CARD):
            cleaned=clean_dialogue(text)
            self.assertEqual(clean_dialogue(cleaned),cleaned)


class Layout(unittest.TestCase):
    def test_line_limit_preserves_readable_ellipsis(self):
        text=wrap_dialogue('鲸鱼娘'*150,len,12,6)
        self.assertLessEqual(len(text.splitlines()),6)
        self.assertTrue(text.endswith('…'))
        self.assertTrue(all(len(line)<=12 for line in text.splitlines()))

    def test_edge_placement_and_pointer_flip(self):
        work=(0,0,1280,720)
        size=(300,140)
        for body in ((0,0,160,160),(1150,10,1280,180),(500,550,680,710),(500,300,680,480)):
            x,y,tail,tip=bubble_position(body,size,work)
            self.assertGreaterEqual(x,0)
            self.assertGreaterEqual(y,0)
            self.assertLessEqual(x+size[0],work[2])
            self.assertLessEqual(y+size[1],work[3])
            self.assertTrue(26<=tip<=size[0]-26)
        self.assertEqual(bubble_position((500,0,680,160),size,work)[2],'up')

    def test_negative_origin_monitor(self):
        x,y,_,_=bubble_position((-1880,-160,-1700,20),(300,160),(-1920,-200,0,880))
        self.assertTrue(-1920<=x and x+300<=0)
        self.assertTrue(-200<=y and y+160<=880)


class Spoken(unittest.TestCase):
    def bridge(self,reply):
        calls=[]
        class Tts:
            def synthesize(self,text,voice):
                calls.append(text)
                return 'unused-fake.wav'
        class Llm:
            def ask(self,text):
                return reply
        b=VoiceBridge(None,Tts(),Llm(),play=lambda path:None)
        return b,calls

    def test_voice_filters_ui_but_return_contract_stays_raw(self):
        raw='晚安。\n```dsh-ui\n{"title":"工具箱","items":[]}\n```'
        b,calls=self.bridge(raw)
        bubbles=[]
        b.on_reply=bubbles.append
        out=b.ask_text('睡了吗')
        self.assertEqual(out['reply'],raw)
        self.assertEqual(bubbles,['晚安。'])
        self.assertEqual(calls,['晚安。'])

    def test_direct_say_and_machine_only_reply_do_not_synthesize_json(self):
        b,calls=self.bridge('```dsh-ui\n{"title":"卡","items":[]}')
        self.assertEqual(b.ask_text('x')['wavs'],[])
        self.assertEqual(b.speak('```json\n{"x":1}')['wavs'],[])
        self.assertEqual(calls,[])
        self.assertEqual(b.state,'idle')


class NativeBubble(unittest.TestCase):
    def setUp(self):
        import tkinter as tk
        try:
            self.root=tk.Tk()
        except tk.TclError as exc:
            self.skipTest(str(exc))
        self.root.withdraw()
        class Pet:
            root=self.root
            def body_screen(self):return (-5500,-5500,-5300,-5300)
            def work_area(self):return (-6000,-6000,-2400,-2400)
        self.b=Bubble(Pet())

    def tearDown(self):
        if hasattr(self,'root'):
            self.b.destroy()
            self.root.destroy()

    def test_actual_font_layout_long_text_and_machine_hide(self):
        self.b.show('晚安，鲸鱼娘。'*100)
        self.root.update()
        text=self.b.label.cget('text')
        self.assertLessEqual(len(text.splitlines()),6)
        self.assertTrue(text.endswith('…'))
        self.assertLess(self.b._size[1],220)
        self.assertLessEqual(self.b._size[0],316)
        self.b.show('```dsh-ui\n{"title":"卡","items":[]}')
        self.assertEqual(self.b.win.state(),'withdrawn')
        self.assertEqual(self.b.until,0)

    def test_expiry_and_hold(self):
        self.b.show('在呢。',1)
        end=self.b.until
        self.b.hold(3)
        self.assertGreater(self.b.until,end)
        self.b.until=time.monotonic()-1
        self.b.follow()
        self.assertEqual(self.b.win.state(),'withdrawn')


if __name__=='__main__':unittest.main()
