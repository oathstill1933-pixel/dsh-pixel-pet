"""Independent cache corruption tests; fabricated arrays only, no model or voice access."""
import os
import tempfile
import types
import unittest
from unittest import mock

import helpers  # noqa: F401
import numpy as np
import tts_worker as worker


class CacheSchemaTests(unittest.TestCase):
    def read_fixture(self, payload):
        protocol = types.ModuleType('qwen3_tts_gguf.inference.schema.protocol')
        protocol.DecoderState = types.SimpleNamespace
        spec = {'anchorSha': 'synthetic-anchor', 'modelRev': 'synthetic-model'}
        with tempfile.TemporaryDirectory(prefix='pp-lead-tts-cache-') as root:
            path = os.path.join(root, 'synthetic-state.npz')
            base = {
                '_schema': np.int64(worker.STATE_SCHEMA),
                '_anchor_sha': spec['anchorSha'], '_model_rev': spec['modelRev'],
                '_provider': 'CPU', '_ort': 'fixture', '_codes_sha': 'fixture',
                '_kv_len': np.int64(16), '_skip_samples': np.int64(0),
                'pre_conv_history': np.zeros((1, 512, 2), dtype=np.float32),
                'latent_buffer': np.zeros((1, 1024, 4), dtype=np.float32),
                'conv_history': np.zeros((1, 1024, 2), dtype=np.float32),
            }
            for index in range(16):
                base['kv_%d' % index] = np.zeros((1, 16, 2, 64), dtype=np.float32)
            base.update(payload)
            np.savez_compressed(path, **base)
            with mock.patch.dict('sys.modules', {protocol.__name__: protocol}):
                return worker._state_load(path, spec, 'CPU', 'fixture', 'fixture')

    def test_well_formed_synthetic_fixture_is_accepted(self):
        # Prove that corruption tests exercise validation, not just a mocked import failure.
        state = self.read_fixture({})
        self.assertIsNotNone(state)
        self.assertEqual(state.pre_conv_history.shape, (1, 512, 2))

    def test_wrong_batch_or_channel_is_cache_miss(self):
        for shape in ((2, 512, 2), (1, 7, 2), (1, 512, 400)):
            with self.subTest(shape=shape):
                self.assertIsNone(self.read_fixture({
                    'pre_conv_history': np.zeros(shape, dtype=np.float32)}))

    def test_nonfinite_cache_is_cache_miss(self):
        for number in (float('nan'), float('inf')):
            with self.subTest(number=number):
                self.assertIsNone(self.read_fixture({
                    'pre_conv_history': np.full((1, 512, 2), number, dtype=np.float32)}))

    def test_invalid_skip_samples_is_not_silently_clamped(self):
        for samples in (-1, 10**12):
            with self.subTest(samples=samples):
                self.assertIsNone(self.read_fixture({'_skip_samples': np.int64(samples)}))


if __name__ == '__main__':
    unittest.main()
