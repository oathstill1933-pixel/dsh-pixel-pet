"""Takeover safety regressions. Synthetic signals/stubs/new temp directories ONLY.
No microphone, production settings, user voiceprints, cloned voices or anchors are touched.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'runtime'))
from pixelpet.voice import sv
from pixelpet.voice.bridge import VoiceBridge
from pixelpet.voiceprint_integration import VoicePrintHost, sanitize, wav_to_pcm
from pixelpet.voiceprint_window import EnrollWindow, check_quality


class TempSV(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='pixelpet-sv-synthetic-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.model = self.root / 'models' / 'speaker-model' / 'synthetic.fake.onnx'
        self.model.parent.mkdir(parents=True)
        self.model.write_bytes(b'public-synthetic-model-rev-A')
        self.cfg = {'enabled': True, 'mode': 'memory', 'strictness': 0.5}
        self.eng = sv.VoicePrint(str(self.root), settings_getter=lambda: self.cfg,
                                 model_path=str(self.model), embedder=sv.StubEmbedder())

    def pcm(self, tag=1):
        return sv.StubEmbedder.pcm(tag, seconds=2.5)

    def enroll(self, name='a', tag=1):
        return self.eng.enroll(name, [self.pcm(tag) for _ in range(5)])


class CoreRegressions(TempSV):
    def test_first_embed_preserves_the_same_salt_until_enrollment(self):
        context = self.eng.enrollment_context()
        vecs = [self.eng.embed(self.pcm()) for _ in range(5)]
        self.assertEqual(context, self.eng.enrollment_context())
        self.assertTrue(self.eng.enroll_vectors('a', vecs, context=context)['ok'])
        self.assertTrue(self.eng.verify(self.pcm())['ok'])
        self.assertFalse((self.root / 'voiceprint').exists())

    def test_vector_enrollment_requires_five_and_current_context(self):
        context = self.eng.enrollment_context()
        vecs = [self.eng.embed(self.pcm()) for _ in range(5)]
        self.assertFalse(self.eng.enroll_vectors('a', vecs[:3], context=context)['ok'])
        self.model.write_bytes(b'public-synthetic-model-rev-B')
        self.assertFalse(self.eng.enroll_vectors('a', vecs, context=context)['ok'])

    def test_rev_update_by_delete_or_self_template_is_impossible(self):
        self.assertTrue(self.enroll('a', 1)['ok'])
        self.assertTrue(self.enroll('b', 2)['ok'])
        old = self.eng._tpl.rev
        self.model.write_bytes(b'public-synthetic-model-rev-B')
        self.assertTrue(self.eng.remove('b')['ok'])
        self.assertEqual(old, self.eng._tpl.rev)
        self.assertEqual(self.eng.verify(self.pcm())['reason'], 'model-rev')
        self.assertFalse(self.eng.set_self_template('public-preset', [self.pcm(3)])['ok'])
        self.assertEqual(old, self.eng._tpl.rev)

    def test_reenroll_after_rev_change_drops_all_stale_people(self):
        self.enroll('a', 1)
        self.enroll('b', 2)
        self.model.write_bytes(b'public-synthetic-model-rev-B')
        self.assertTrue(self.enroll('c', 3)['ok'])
        self.assertEqual([p['name'] for p in self.eng.people()], ['c'])

    def test_mode_roundtrip_never_resurrects_old_disk_people(self):
        self.cfg['mode'] = 'disk'
        self.assertTrue(self.enroll('old', 1)['ok'])
        self.cfg['mode'] = 'memory'
        self.assertEqual(self.eng.readiness()[1], 're-enroll')
        self.assertTrue(self.enroll('mem', 2)['ok'])
        self.cfg['mode'] = 'disk'
        self.assertEqual(self.eng.readiness()[1], 're-enroll')
        self.assertEqual(self.eng.people(), [])
        self.assertTrue(self.enroll('new', 3)['ok'])
        self.assertEqual([p['name'] for p in self.eng.people()], ['new'])

    def test_failed_save_does_not_change_active_template(self):
        self.cfg['mode'] = 'disk'
        self.assertTrue(self.enroll()['ok'])
        with patch.object(self.eng._codec, 'write', side_effect=OSError('synthetic save failure')):
            self.assertFalse(self.enroll('b', 2)['ok'])
            self.assertFalse(self.eng.remove('a')['ok'])
        self.assertEqual([p['name'] for p in self.eng.people()], ['a'])
        self.assertTrue(self.eng.verify(self.pcm())['ok'])

    def test_missing_disk_salt_cannot_reuse_existing_templates(self):
        self.cfg['mode'] = 'disk'
        self.assertTrue(self.enroll()['ok'])
        salt_path = self.root / 'voiceprint' / 'ortho.bin'
        self.assertEqual(salt_path.resolve().parent, (self.root / 'voiceprint').resolve())
        salt_path.unlink()  # this test's synthetic salt only
        fresh = sv.VoicePrint(str(self.root), settings_getter=lambda: self.cfg,
                              model_path=str(self.model), embedder=sv.StubEmbedder())
        self.assertFalse(fresh.verify(self.pcm())['ok'])
        self.assertTrue(fresh.salt_broken)
        self.assertTrue(fresh.clear()['ok'])
        self.assertTrue(fresh.enroll('new', [self.pcm() for _ in range(5)])['ok'])

    def test_failed_clear_cannot_report_success_or_forget_template(self):
        self.cfg['mode'] = 'disk'
        self.enroll()
        with patch('pixelpet.voice.sv.os.remove', side_effect=OSError('synthetic deletion failure')):
            self.assertFalse(self.eng.clear()['ok'])
        self.assertEqual(len(self.eng.people()), 1)

    def test_unknown_digest_invalidates_self_not_fake_ready(self):
        self.enroll()
        self.eng.voice_digest_getter = lambda: 'public-preset-digest'
        self.assertTrue(self.eng.set_self_template('public-preset-digest', [self.pcm(3)])['ok'])
        self.assertEqual(self.eng.echo_state(), 'ok')
        self.eng.voice_digest_getter = lambda: None
        out = self.eng.verify(self.pcm())
        self.assertFalse(out['self_ready'])
        self.assertIsNone(out['self_sim'])

    def test_invalid_template_dim_or_vector_never_parses(self):
        import numpy as np
        t = sv.Templates(rev='synthetic')
        t.put('x', np.ones(192), 5, 0.4)
        t.people[0]['vec'][0] = np.nan
        with self.assertRaises(sv.SvError):
            sv.Templates.from_bytes(t.to_bytes())
        t.dim = 191
        with self.assertRaises(sv.SvError):
            sv.Templates.from_bytes(t.to_bytes())

    def test_invalid_settings_never_bypass_gate(self):
        self.enroll()
        self.cfg['strictness'] = float('nan')
        self.assertEqual(self.eng.verify(self.pcm())['reason'], 'config-error')


class Facade(TempSV):
    def test_disabled_facade_no_engine_no_biometric_io(self):
        pet = SimpleNamespace(cfg={}, data_dir=str(self.root))
        h = VoicePrintHost(pet)
        with patch.object(h, 'engine', side_effect=AssertionError('no engine on disabled verify')):
            self.assertTrue(h.verify(b'')['ok'])
        self.assertFalse((self.root / 'voiceprint').exists())
        self.assertEqual(set(h.summary()), {'enabled', 'enrolled', 'last'})

    def test_attached_facade_follows_switch_and_config_failure(self):
        pet = SimpleNamespace(cfg={'voiceprint': dict(self.cfg)}, data_dir=str(self.root))
        h = VoicePrintHost(pet)
        self.assertIs(h.verifier(), h)
        self.assertFalse(h.verify(self.pcm())['ok'])  # model not initialized but must not bypass
        pet.cfg = {}
        self.assertTrue(h.enabled)
        self.assertEqual(h.verify(self.pcm())['reason'], 'config-error')
        pet.cfg = {'voiceprint': {'enabled': False}}
        self.assertTrue(h.verify(b'')['ok'])

    def test_explicit_load_error_marker_never_turns_off_gate(self):
        h = VoicePrintHost(SimpleNamespace(cfg={'_voiceprintConfigError': True}, data_dir=str(self.root)))
        self.assertTrue(h.enabled)
        self.assertEqual(h.verify(b'')['reason'], 'config-error')

    def test_mode_change_while_disabled_does_not_resurrect_disk_people(self):
        self.cfg['mode'] = 'disk'
        self.assertTrue(self.enroll('old', 1)['ok'])
        pet = SimpleNamespace(cfg={'voiceprint': dict(self.cfg)}, data_dir=str(self.root))
        h = VoicePrintHost(pet)
        self.assertEqual(h.status()['enrolled'], 1)
        pet.cfg['voiceprint'] = {'enabled': False, 'mode': 'memory'}
        self.assertTrue(h.verify(b'')['ok'])
        pet.cfg['voiceprint'] = {'enabled': True, 'mode': 'disk'}
        self.assertEqual(h.status()['reason'], 're-enroll')
        self.assertEqual(h.people(), [])

    def test_native_window_refuses_existing_manual_recording(self):
        pet = SimpleNamespace(cfg={'voiceprint': dict(self.cfg)}, data_dir=str(self.root),
                              mic=SimpleNamespace(active=True))
        self.assertFalse(VoicePrintHost(pet).open_enroll_window()[0])

    def test_native_window_suspends_and_restores_continuous_listener_without_recording(self):
        calls = []
        pet = SimpleNamespace(cfg={'voiceprint': dict(self.cfg)}, data_dir=str(self.root),
                              mic=None, listener=object(), root=None, post_ui=lambda fn: fn(),
                              set_listening=lambda on: calls.append(on))
        h = VoicePrintHost(pet)
        with patch('pixelpet.voiceprint_window.EnrollWindow', return_value=object()):
            self.assertTrue(h.open_enroll_window()[0])
        self.assertEqual(calls, [False])
        h._window_closed()
        self.assertEqual(calls, [False, True])

    def test_self_adapter_does_not_call_tts_or_open_clones(self):
        def fail(*args):
            raise AssertionError('must not synthesize or read anchor')
        pet = SimpleNamespace(cfg={'voiceprint': dict(self.cfg)}, data_dir=str(self.root),
                              voice=SimpleNamespace(tts=SimpleNamespace(synthesize=fail)))
        self.assertFalse(VoicePrintHost(pet).rebuild_self_template()['ok'])

    def test_sanitize_only_three_keys_and_rejects_invalid_input(self):
        self.assertEqual(set(sanitize({'enabled': True, 'name': 'private', 'vector': [1]})),
                         {'enabled', 'mode', 'strictness'})
        for raw in ([], 'bad', {'enabled': 'false'}, {'strictness': float('inf')}, {'mode': 'weird'}):
            with self.assertRaises((ValueError, TypeError)):
                sanitize(raw)


class Value:
    def __init__(self, s=''):
        self.s = s
    def get(self):
        return self.s
    def set(self, s):
        self.s = s
    def configure(self, **kw):
        pass


class NativeWindow(TempSV):
    def window(self):
        w = EnrollWindow.__new__(EnrollWindow)  # no Tk and no real recorder
        w.engine = self.eng
        w.sentences = ['synthetic prompt'] * 5
        w.test_only, w.closed, w.busy = False, False, False
        w.vecs, w.index = [], 0
        w.context = self.eng.enrollment_context()
        w.name_var = Value('synthetic-person')
        w.msg = Value()
        w.progress = Value()
        w.sentence_var = Value()
        w.rec_btn, w.done_btn = Value(), Value()
        w.post = lambda fn: fn()
        w.max_people, w._names = 5, lambda: []
        w.on_done, w.on_close = None, None
        w._destroy = lambda: setattr(w, 'closed', True)
        return w

    def test_quality_silence_short_clipped_and_valid(self):
        self.assertFalse(check_quality(b'\0\0' * 40000)[0])
        self.assertFalse(check_quality(sv.StubEmbedder.pcm(1, seconds=1))[0])
        self.assertFalse(check_quality(b'\xff\x7f' * 40000)[0])
        self.assertTrue(check_quality(self.pcm())[0])

    def test_five_sentences_without_retaining_pcm(self):
        w = self.window()
        for i in range(3):
            w._accept(self.pcm())
        w.finish()
        self.assertFalse(w.closed)
        self.assertFalse(hasattr(w, 'pcms'))
        for i in range(2):
            w._accept(self.pcm())
        w.finish()
        self.assertTrue(w.closed)
        self.assertTrue(self.eng.verify(self.pcm())['ok'])
        self.assertEqual(w.vecs, [])

    def test_consistency_rejects_other_synthetic_tag(self):
        w = self.window()
        w._accept(self.pcm(1))
        w._accept(self.pcm(2))
        self.assertEqual(w.index, 1)

    def test_local_test_history_has_no_http_channel(self):
        self.enroll()
        w = self.window()
        w.test_only, w.test_history = True, []
        for _ in range(12):
            w._accept(self.pcm())
        self.assertEqual(len(w.test_history), 10)
        self.assertIn('通过', w.msg.get())


class GateMalformed(unittest.TestCase):
    def test_malformed_verifier_response_is_failclosed(self):
        for output in (None, True, {}, {'ok': 1}, {'ok': False, 'reason': 'disabled'}):
            b = VoiceBridge(None, None, None, play=lambda _: None,
                            sv=SimpleNamespace(verify=lambda *a: output))
            out = b.hear(b'')
            self.assertTrue(out['rejected'])
            self.assertEqual(b._turn, 0)
            self.assertEqual(b.state, 'idle')


class PrivacyScanner(unittest.TestCase):
    def test_metadata_rejects_without_opening_forbidden_files(self):
        spec = importlib.util.spec_from_file_location('sv_privacy_scan', ROOT / 'tools' / 'privacy_scan.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        with tempfile.TemporaryDirectory(prefix='pixelpet-sv-scan-') as temp:
            root = Path(temp)
            (root / '.gitignore').write_text('', encoding='utf8')
            (root / 'package.json').write_text('{"files":[]}', encoding='utf8')
            (root / 'voiceprint').mkdir()
            (root / 'voiceprint' / 'templates.bin').write_bytes(b'synthetic-not-biometric')
            (root / 'secret.txt').write_text('synthetic-do-not-open', encoding='utf8')
            real_open = open
            def guarded(p, *args, **kwargs):
                if mod.forbidden_path(p):
                    raise AssertionError('forbidden file opened')
                return real_open(p, *args, **kwargs)
            with patch.object(mod, 'ROOT', temp), patch('builtins.open', guarded):
                _, _, hits = mod.scan(public_only=True)
            self.assertEqual(len([h for h in hits if h['rule'] == 'private-voice-path']), 2)


class NodeBoundary(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'node unavailable')
    def test_dedicated_api_auth_routes_and_response_whitelists(self):
        script = r'''
import assert from 'node:assert/strict';
import {createVoicePrintApi, agentSummary, localUiRequest} from './lib/voiceprint.js';
let calls=[];
const api=createVoicePrintApi({send:async body=>{calls.push(body); return {ok:true,extra:{enabled:true,enrolled:1,last:'pass',people:[{name:'synthetic',n:5,vec:[1]}],vec:[1],score:0.9}}}});
const req={socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:3080',referer:'http://127.0.0.1:3080/dsh-pixel-pet/','x-pixelpet-ui':'1','sec-fetch-site':'same-origin'}};
assert(localUiRequest(req));
assert(!localUiRequest({...req,socket:{remoteAddress:'192.0.2.1'}}));
assert(!localUiRequest({...req,headers:{...req.headers,host:'evil.example'}}));
assert(!localUiRequest({...req,headers:{...req.headers,origin:'http://evil.example'}}));
assert.equal((await api.handle('GET','/api/voiceprint/people',{},req)).code,401);
const boot=await api.handle('GET','/api/voiceprint/session',{},req);
req.headers['x-pixelpet-voiceprint']=boot.body.capability;
const people=await api.handle('GET','/api/voiceprint/people',{},req);
assert.deepEqual(people.body.people,[{name:'synthetic',n:5}]);
const st=await api.handle('GET','/api/voiceprint',{},req);
assert(!('people' in st.body)); assert(!('vec' in st.body)); assert(!('score' in st.body));
const n=calls.length;
for (const p of ['audio','vector','self']) assert.equal((await api.handle('POST','/api/voiceprint/'+p,{},req)).code,404);
assert.equal(calls.length,n);
for (const p of ['enroll','test','clear']) assert.deepEqual((await api.handle('POST','/api/voiceprint/'+p,{},req)).body,{ok:true});
assert.equal((await api.handle('POST','/api/voiceprint/enroll',{},null)).code,403);
assert.deepEqual(agentSummary({enabled:true,enrolled:1,last:'pass',name:'synthetic',score:1,vec:[1]}),{enabled:true,enrolled:1,last:'pass'});
console.log('SV node boundaries passed');
'''
        result = subprocess.run([shutil.which('node'), '--input-type=module', '-e', script],
                                cwd=ROOT, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
