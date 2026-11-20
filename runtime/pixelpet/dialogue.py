"""Conversation text for the desktop bubble and TTS, never the stored DSH reply.

Remove machine-only UI/tool blocks before display truncation. Unknown braces,
normal identifiers, human text, and inline-code labels remain readable.
"""
import html
import json
import re

from . import tone

# Only a closed fence is a code block; a lone ```  is ordinary text, not "hide everything after".
_FENCES = re.compile(r'(?P<fence>`{3,}|~{3,}).*?(?P=fence)', re.S)
# Exception: a cut-off machine card (line-start fence tagged dsh-ui / json) still hides to the end,
# so a truncated UI payload never leaks into the bubble or TTS.
_CUT_CARD = re.compile(r'(?im)^[ \t]*(?:`{3,}|~{3,})[ \t]*(?:dsh[-_]?ui|json5?|jsonc|application/json)[ \t]*\n.*\Z', re.S)
# Markdown emphasis. Markers must hug non-space text and must not touch ASCII word characters
# outside (CJK neighbours are fine), so __init__.py, my_var__x, 2 * 3 * 4 and *args / **kwargs
# stay literal. A dunder name between __ markers (__init__) is code, not bold.
_EMPHASIS = [re.compile(r'(?<![A-Za-z0-9_*])\*\*(?=[^\s*])([^\n]+?)(?<=[^\s*])\*\*(?![A-Za-z0-9_*])'),
             re.compile(r'(?<![A-Za-z0-9_])__(?=[^\s_])([^\n]+?)(?<=[^\s_])__(?![A-Za-z0-9_]|\.\w)'),
             re.compile(r'(?<![A-Za-z0-9_~])~~(?=[^\s~])([^\n]+?)(?<=[^\s~])~~(?![A-Za-z0-9_~])'),
             re.compile(r'(?<![A-Za-z0-9_*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![A-Za-z0-9_*])')]
_HIDDEN = re.compile(
    r'<(?P<tag>think|thinking|analysis|tool_call|tool_calls|tool_result|function_call|function_result|dsh-ui)\b[^>]*>'
    r'.*?(?:</(?P=tag)\s*>|\Z)', re.I | re.S)
_DECODER = json.JSONDecoder()
_TOOL_KEYS = {'tool_calls', 'tool_call', 'function_call', 'function', 'arguments', 'tool_result'}


def _machine(value):
    if isinstance(value, list):
        return bool(value) and any(_machine(item) for item in value if isinstance(item, dict))
    if not isinstance(value, dict):
        return False
    keys = set(value)
    return bool(keys & _TOOL_KEYS) or ('items' in keys and bool(keys & {'title', 'gap', 'type'})) or (
        'type' in keys and bool(keys & {'children', 'props', 'content'}) and
        value.get('type') in {'row', 'column', 'card', 'list', 'grid', 'tabs', 'button', 'panel'})


def _drop_payloads(text):
    out=[]
    i=0
    while i<len(text):
        if text[i] not in '[{':
            out.append(text[i])
            i+=1
            continue
        try:
            value,end=_DECODER.raw_decode(text,i)
        except ValueError:
            # Recognise a cut-off UI/tool payload too; don't leak the first 400 chars.
            head=text[i:i+1600]
            if (re.match(r'\{\s*"(?:title|type|tool_calls|function_call)"\s*:',head) and
                    re.search(r'"(?:items|children|arguments|tool_calls)"\s*:',head)):
                break
            out.append(text[i])
            i+=1
            continue
        if _machine(value):
            out.append('\n')
        else:
            out.append(text[i:end])
        i=end
    return ''.join(out)


def clean_dialogue(value):
    """Plain human-facing text; returns empty for machine-only replies."""
    text=html.unescape(str(value or '')).replace('\r\n','\n').replace('\r','\n')
    text=tone.strip_leading(text)   # a leading tone tag is read by the voice layer, never shown
    text=re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b\ufeff]','',text)
    text=_FENCES.sub('\n',text)
    text=_CUT_CARD.sub('\n',text)
    text=_HIDDEN.sub('\n',text)
    text=re.sub(r'<\|[^<>\n]*\|>','',text)
    text=_drop_payloads(text)
    text=re.sub(r'(?im)^\s*(?:dsh[-_]ui|application/json)\s*:?\s*$', '',text)
    text=re.sub(r'!\[[^\]]*\]\([^\n)]*\)','',text)
    text=re.sub(r'\[([^\]\n]+)\]\([^\n)]*\)',r'\1',text)
    text=re.sub(r'</?(?:p|div|span|b|strong|i|em|br|ul|ol|li)\b[^>]*>','',text,flags=re.I)
    text=re.sub(r'(?m)^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)','',text)
    text=re.sub(r'(`+)([^`\n]+)\1',r'\2',text)
    for pattern in _EMPHASIS:
        text=pattern.sub(lambda m:m.group(0) if re.fullmatch(r'__[A-Za-z0-9_]+__',m.group(0)) else m.group(1),text)
    text='\n'.join(re.sub(r'[ \t]+',' ',line).strip() for line in text.splitlines())
    return re.sub(r'\n{3,}','\n\n',text).strip()
