"""Native regression coverage for mapped overlays, complete groups and late card resets."""
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

RUNTIME = Path(os.environ.get('PIXELPET_RUNTIME', Path(__file__).resolve().parents[1] / 'runtime'))
sys.path.insert(0, str(RUNTIME))
sys.path.insert(0, str(RUNTIME / 'music'))
from pixelpet import window as W
from pixelpet.app import PetApp
from pixelmusic import cardwin as CW
from test_card_owner_native import NativeOwnerTopmost


@unittest.skipUnless(os.name == 'nt', 'requires Windows')
class GroupWindows(unittest.TestCase):
    def setUp(self):
        import tkinter as tk
        self.root = tk.Tk()
        self.root.geometry('+30000+30000')
        self.addCleanup(self.root.destroy)
        W.overlay(self.root, 16, 16)
        self.app = object.__new__(PetApp)
        self.app.root, self.app.topmost = self.root, True
        def child():
            win = tk.Toplevel(self.root)
            win.geometry('+30000+30000')
            W.overlay(win, 16, 16)
            return win
        self.app.hub = SimpleNamespace(win=child(), chip=child(), tip=SimpleNamespace(win=child()))
        self.app.furniture = {'book': SimpleNamespace(win=child())}
        self.app.bubble = SimpleNamespace(windows=[child()])
        self.child = child
        self.root.update()

    def windows(self):
        return [self.root, self.app.hub.win, self.app.hub.chip, self.app.hub.tip.win,
                *[f.win for f in self.app.furniture.values()], *self.app.bubble.windows]

    def test_all_windows_and_late_windows_follow_switch(self):
        self.app.furniture['late'] = SimpleNamespace(win=self.child())
        self.app.bubble.windows.append(self.child())
        for on in (False, True):
            self.app.apply_topmost(on)
            self.root.update()
            self.assertTrue(all(W.topmost_matches(W.hwnd_of(w), on) for w in self.windows()))
            self.assertTrue(all(bool(w.attributes('-topmost')) == on for w in self.windows()))

    def test_remapping_repairs_native_reset(self):
        win = self.app.hub.chip
        win.withdraw()
        W.force_topmost(win, False)
        win.deiconify()
        self.root.update()
        self.assertTrue(W.topmost_matches(W.hwnd_of(win), True))

    def test_healthy_group_is_not_repeatedly_raised(self):
        self.app.apply_topmost(True)
        self.root.update()
        with patch.object(W, 'force_topmost', wraps=W.force_topmost) as force:
            self.app.apply_topmost()
            force.assert_not_called()

    def assert_pet_above_furniture(self):
        import ctypes as ct
        from ctypes import wintypes as wt
        u = ct.windll.user32
        u.GetWindow.argtypes = [wt.HWND, wt.UINT]
        u.GetWindow.restype = wt.HWND
        root = W.hwnd_of(self.root)
        for furniture in self.app.furniture.values():
            hwnd = W.hwnd_of(furniture.win)
            seen = set()
            while hwnd and hwnd not in seen and hwnd != root:
                seen.add(hwnd)
                hwnd = u.GetWindow(hwnd, 3)
            self.assertEqual(hwnd, root, 'furniture must remain behind the pet')

    def test_group_repair_keeps_furniture_behind_pet(self):
        self.app.furniture['late'] = SimpleNamespace(win=self.child())
        self.app.apply_topmost(True)
        self.root.update()
        # Reproduce a furniture window being promoted after the pet during native repair.
        for f in self.app.furniture.values():
            W.force_topmost(f.win, True)
        self.app.apply_topmost()
        self.assert_pet_above_furniture()
        self.assertTrue(all(W.topmost_matches(W.hwnd_of(w), True) for w in self.windows()))

    def test_furniture_remap_and_drag_keep_internal_order(self):
        self.app.apply_topmost(True)
        win = self.app.furniture['book'].win
        win.withdraw()
        win.deiconify()
        self.root.update()
        W.force_topmost(win, True)  # activation/drag can raise an independent furniture window
        self.app._restack_furniture()
        self.assert_pet_above_furniture()
        with patch.object(W, 'z_below', wraps=W.z_below) as reorder:
            self.app._restack_furniture()
            reorder.assert_not_called()

    def test_furniture_order_with_topmost_disabled(self):
        self.app.apply_topmost(False)
        self.root.update()
        self.app.apply_topmost(False)
        self.assert_pet_above_furniture()
        self.assertTrue(all(W.topmost_matches(W.hwnd_of(w), False) for w in self.windows()))

    def test_hidden_pet_does_not_lower_occupied_furniture(self):
        self.app.apply_topmost(True)
        self.root.withdraw()
        with patch.object(W, 'z_below', wraps=W.z_below) as reorder:
            self.app._restack_furniture()
            reorder.assert_not_called()
        self.assertTrue(W.topmost_matches(W.hwnd_of(self.app.furniture['book'].win), True))


class CardLateReset(NativeOwnerTopmost):
    def test_stationary_card_repairs_native_reset(self):
        dock = {'body': [-30000, -30000, -29900, -29900],
                'work': [-31000, -31000, -29000, -29000], 'topmost': True,
                'visible': True, 'owner': self.owner}
        self.win.find = lambda: self.win.hwnd
        self.win.show = lambda on: None
        self.win.shape = lambda *args: None
        self.win.scale = lambda: 1.0
        card = CW.Card('unused', os.getpid(), self.win, read=lambda: dock)
        card.step()
        # A framework resets the native window after our first placement; geometry/config stay unchanged.
        self.u.SetWindowPos(self.win.hwnd, -2, 0, 0, 0, 0, 0x13)
        card.step()
        self.assertTrue(self.flags()[1])

    def test_stale_native_bit_is_not_enough(self):
        # SetWindowLong alone can leave TOPMOST set while the window is in the ordinary band.
        self.u.ShowWindow(self.win.hwnd, 4)
        self.u.SetWindowPos(self.win.hwnd, -2, 0, 0, 0, 0, 0x13)
        ordinary = self.new_window()
        self.u.ShowWindow(ordinary, 4)
        self.u.SetWindowPos(ordinary, -2, 0, 0, 0, 0, 0x13)
        ex = self.u.GetWindowLongW(self.win.hwnd, -20)
        self.u.SetWindowLongW(self.win.hwnd, -20, ex | 8)
        self.assertFalse(W.topmost_matches(self.win.hwnd, True))
        self.win.sync_topmost(True)
        self.assertTrue(W.topmost_matches(self.win.hwnd, True))


if __name__ == '__main__':
    unittest.main(verbosity=2)
