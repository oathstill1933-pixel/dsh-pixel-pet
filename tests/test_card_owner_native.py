"""Windows regression: use hidden native windows to check the actual owner topmost bit.

Run with PIXELPET_RUNTIME pointing to runtime/; CARDWIN_SOURCE optionally selects a staged module.
"""
import ctypes as ct
from ctypes import wintypes as wt
import importlib.util
import os
from pathlib import Path
import sys
import unittest

RUNTIME = Path(os.environ.get('PIXELPET_RUNTIME', Path(__file__).resolve().parents[1] / 'runtime'))
sys.path.insert(0, str(RUNTIME))
sys.path.insert(0, str(RUNTIME / 'music'))
if os.environ.get('CARDWIN_SOURCE'):
    spec = importlib.util.spec_from_file_location('pixelmusic.cardwin', os.environ['CARDWIN_SOURCE'])
    CW = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = CW
    spec.loader.exec_module(CW)
else:
    from pixelmusic import cardwin as CW


@unittest.skipUnless(os.name == 'nt', 'requires Windows')
class NativeOwnerTopmost(unittest.TestCase):
    def setUp(self):
        self.win = CW.Win()
        self.u = self.win.u
        self.u.CreateWindowExW.argtypes = [wt.DWORD, wt.LPCWSTR, wt.LPCWSTR, wt.DWORD,
            ct.c_int, ct.c_int, ct.c_int, ct.c_int, wt.HWND, wt.HMENU, wt.HINSTANCE, wt.LPVOID]
        self.u.CreateWindowExW.restype = wt.HWND
        self.u.DestroyWindow.argtypes = [wt.HWND]
        self.u.GetWindow.argtypes = [wt.HWND, wt.UINT]
        self.u.GetWindow.restype = wt.HWND
        self.owner = self.new_window()
        self.win.hwnd = self.new_window()

    def new_window(self):
        hwnd = self.u.CreateWindowExW(0x08000080, 'STATIC', 'pixelpet-regression-hidden',
                                     0x80000000, -30000, -30000, 16, 16, None, None, None, None)
        self.assertTrue(hwnd)
        self.addCleanup(self.u.DestroyWindow, hwnd)
        self.assertTrue(self.u.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x13))
        return hwnd

    def flags(self):
        return tuple(bool(self.u.GetWindowLongW(h, -20) & 8) for h in (self.owner, self.win.hwnd))

    def test_bind_card_preserves_topmost_owner(self):
        self.assertEqual(self.flags(), (True, True))
        self.win.own(self.owner)
        self.assertEqual(self.u.GetWindow(self.win.hwnd, 4), self.owner)
        self.assertEqual(self.flags(), (True, True), 'binding a card must not demote the pet')
        self.win.place(-30000, -30000, 16, 16, True, owned=True)
        self.assertEqual(self.flags(), (True, True))

    def test_full_startup_keeps_pet_and_card_topmost(self):
        self.win.own(self.owner)
        self.win.place(-30000, -30000, 16, 16, True, owned=True)
        self.assertEqual(self.flags(), (True, True), 'card startup must leave the pet topmost')

    def test_topmost_off_and_back_on(self):
        self.assertTrue(self.u.SetWindowPos(self.owner, -2, 0, 0, 0, 0, 0x13))
        self.win.own(self.owner)
        self.win.place(-30000, -30000, 16, 16, False, owned=True)
        self.assertEqual(self.flags(), (False, False))
        self.assertTrue(self.u.SetWindowPos(self.owner, -1, 0, 0, 0, 0, 0x13))
        self.win.place(-30000, -30000, 16, 16, True, owned=True)
        self.assertEqual(self.flags(), (True, True))
        self.assertTrue(self.u.SetWindowPos(self.owner, -2, 0, 0, 0, 0, 0x13))
        self.win.place(-30000, -30000, 16, 16, False, owned=True)
        self.assertEqual(self.flags(), (False, False))

    def test_repeated_owner_binding_preserves_topmost(self):
        for _ in range(3):
            self.win.own(self.owner)
            self.win.place(-30000, -30000, 16, 16, True, owned=True)
            self.assertEqual(self.flags(), (True, True))


if __name__ == '__main__':
    unittest.main(verbosity=2)
