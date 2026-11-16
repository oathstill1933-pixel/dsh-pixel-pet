"""Require memory benchmarks to measure a real process, rather than silently report zeros."""
import os
import unittest

import helpers  # noqa: F401


@unittest.skipUnless(os.name == 'nt', 'Windows process counters')
class ProcessProbeTests(unittest.TestCase):
    def test_own_process_memory_is_measurable(self):
        import perf_voice
        memory = perf_voice.mem_of(os.getpid())
        self.assertIsNotNone(memory)
        working_set, commit = memory
        self.assertGreater(working_set, 0)
        self.assertGreater(commit, 0)
        tree = perf_voice.tree_mem(os.getpid())
        self.assertGreaterEqual(tree['procs'], 1)
        self.assertGreater(tree['ws'], 0)
        self.assertGreater(tree['commit'], 0)


if __name__ == '__main__':
    unittest.main()
