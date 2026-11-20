"""Tone tags: a leading `[快]`-style label maps to a TTS rendering instruction.

Convention: the model may put ONE tone tag at the very start of its reply.
The tag is read once for synthesis and then never shown: bubbles, captions and the spoken
text all get the text without it. Only a tag that opens the message and is registered in a
table counts; ordinary square brackets inside a sentence are left alone.
"""

# Universal fallback, used when a character ships no table of its own.
DEFAULT_TABLE = {
    "快": "语气轻快明朗，带笑意，语速稍快",
    "暖": "语气温柔、暖一点，语速放慢，像贴着耳朵说话",
    "低": "压低声音，收敛、低落，有点委屈",
}

# Whale girl: six tags (the last three are her signature beats).
WHALE_GIRL = {
    "快": "语气轻快明朗，带笑意，语速稍快",
    "暖": "语气温柔、暖一点，语速放慢，像贴着耳朵说话",
    "低": "压低声音，收敛、低落，有点委屈",
    "困": "有气无力，慢吞吞，尾音拖着，像没睡醒",
    "饿": "撒娇，拉长尾音，软软地讨要，有点可怜巴巴",
    "哼": "傲娇嘴硬，小声嘟囔，先不情愿再软下来",
}

# Claude girl: restrained, well-mannered young lady. Her tone must stay inside a narrow
# band — small swings only: steady, slightly slower, slightly softer, never dramatic.
CLAUDE_GIRL = {
    "静": "语调平稳从容，只比平时略慢一点，音量稍低，不做明显起伏",
    "暖": "语气温润柔和，略微放慢、音色稍暖，不要夸张地亲近",
    "轻": "语调轻快一些但仍端庄，句尾稍稍上扬，幅度克制",
    "虑": "语气带一点迟疑，略微放慢，句尾轻轻收住，不要拖长",
    "歉": "语气诚恳柔和，音量略降、语速稍慢，保持平稳，不要发虚",
    "肃": "语调端正清晰，咬字利落，语速略快一点点，不要用力过猛",
}

TABLES = {"whale-girl": WHALE_GIRL, "claude-girl": CLAUDE_GIRL}


def table_for(character=None, extra=None):
    """-> {label: instruction}. Unknown characters fall back to the universal three."""
    table = dict(DEFAULT_TABLE)
    table.update(TABLES.get(str(character or ""), {}))
    if isinstance(extra, dict):
        for key, value in extra.items():
            label, text = clean_label(key), str(value or "").strip()
            if label and text:
                table[label] = text
    return table


def clean_label(label):
    """'[快]' / '快' -> '快'; anything else -> ''."""
    if not isinstance(label, str):
        return ""
    text = label.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1].strip()
    if not text or len(text) > 4 or any(ch in text for ch in "[]\n"):
        return ""
    return text


def known_labels(character=None, extra=None):
    return set(table_for(character, extra))


def take(text, character=None, extra=None):
    """Split a leading tone tag off a message.

    -> (label or None, instruction or None, remaining text). A tag that is not registered
    is left untouched, so `[1]` or a citation at the start is never eaten.
    """
    body = "" if text is None else str(text)
    head = body.lstrip()
    if not head.startswith("["):
        return None, None, body
    end = head.find("]")
    if end <= 1 or end > 5:
        return None, None, body
    label = clean_label(head[:end + 1])
    if not label:
        return None, None, body
    table = table_for(character, extra)
    if label not in table:
        return None, None, body
    return label, table[label], head[end + 1:].lstrip()

def strip_leading(text):
    """Drop one leading registered tag, whichever character it belongs to.

    Display paths use this so a tag can never leak into a bubble even when nobody
    asked for a rendering instruction.
    """
    body = "" if text is None else str(text)
    head = body.lstrip()
    if not head.startswith("["):
        return body
    end = head.find("]")
    if end <= 1 or end > 5:
        return body
    label = clean_label(head[:end + 1])
    if not label:
        return body
    known = set(DEFAULT_TABLE)
    for table in TABLES.values():
        known |= set(table)
    if label not in known:
        return body
    return head[end + 1:].lstrip()
