"""最小门牌写入器（Python 3，标准库）。抄进你自己的桥里就行。

    python write_pointer.py <sessionId> [label]

每次给某个来源新建或切换 DSH 会话之后调一次。字段含义见 docs/FOLLOW.md。
下面三个值全部是假的，换成你自己平台的东西。
"""
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

CHANNEL = "myapp"      # ^[a-z0-9_-]{1,32}$
PEER = "10000"         # 号码 / 频道 id / 房间 id
PET_HOME = True        # 一对一私聊才填 True；群、频道、多人房间填 False

FOLLOW_DIR = os.environ.get("PIXELPET_FOLLOW_DIR") or os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "dsh-pixel-pet", "follow")


def write_pointer(session_id, label="私聊"):
    pointer = {
        "schema": "dsh-pixel-pet/follow@1",
        "channel": CHANNEL,
        "peer": PEER,
        "scope": "direct",
        "petHome": PET_HOME,
        "sessionId": session_id,
        "label": label,
        "updatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "ttlHours": 36,
    }
    os.makedirs(FOLLOW_DIR, exist_ok=True)
    target = os.path.join(FOLLOW_DIR, "%s-%s.json" % (CHANNEL, PEER))
    fd, tmp = tempfile.mkstemp(dir=FOLLOW_DIR, prefix=".ptr-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(pointer, f, ensure_ascii=False, indent=2)
        os.replace(tmp, target)      # 原子替换：桌宠永远读不到半截文件
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return target


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法：python write_pointer.py <sessionId> [label]")
        raise SystemExit(2)
    try:
        print("写了门牌：" + write_pointer(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "私聊"))
    except Exception as error:  # 写失败绝不能影响聊天本身
        print("门牌没写成（不影响聊天）：%s" % error)
