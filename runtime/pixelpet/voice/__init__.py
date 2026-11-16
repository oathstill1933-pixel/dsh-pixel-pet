"""Voice bridge: microphone -> STT -> LLM (a chosen DSH session) -> TTS, driven by VoiceBridge.

Nothing is downloaded on import. The built-in TTS components are installed by the host in the
background when the plugin is first enabled; until then synthesis raises DependencyMissing and the
pet answers in its bubble only.
"""


class VoiceError(Exception):
    pass


class DependencyMissing(VoiceError):
    def __init__(self, dep_id):
        self.dep_id = dep_id
        super().__init__("语音组件还没装好：%s" % dep_id)


class RouteUnset(VoiceError):
    def __init__(self):
        super().__init__("还没选要对话的会话")
