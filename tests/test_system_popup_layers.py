"""Native ordering tests: system popups > overlays > ordinary apps, without changing popup styles."""
import ctypes as ct
from ctypes import wintypes as wt
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

RUNTIME = Path(os.environ.get('PIXELPET_RUNTIME', Path(__file__).resolve().parents[1] / 'runtime'))
sys.path[:0] = [str(RUNTIME), str(RUNTIME / 'music')]
from pixelpet import window as W
from pixelmusic import cardwin as CW
from test_topmost_group import GroupWindows


class PopupPriority(GroupWindows):
    def setUp(self):
        super().setUp()
        self.u = ct.windll.user32
        self.u.GetWindow.argtypes = [wt.HWND, wt.UINT]
        self.u.GetWindow.restype = wt.HWND
        self.u.GetForegroundWindow.restype = wt.HWND
        self.u.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ct.c_int, ct.c_int, ct.c_int, ct.c_int, wt.UINT]
        self.popup = self.child()
        self.root.update()
        self.popup_hwnd = W.hwnd_of(self.popup)
        self.u.SetWindowPos(self.popup_hwnd, -1, 0, 0, 0, 0, 0x13)
        self.patch = patch.object(W, 'system_popups', return_value=(self.popup_hwnd,))
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def above(self, first, second):
        cur, seen = self.u.GetWindow(second, 3), set()
        while cur and cur not in seen:
            if cur == first:
                return True
            seen.add(cur)
            cur = self.u.GetWindow(cur, 3)
        return False

    def test_popup_over_entire_group_and_music_card(self):
        fg = self.u.GetForegroundWindow()
        style = self.u.GetWindowLongW(self.popup_hwnd, -20)
        for win in self.windows():
            self.u.SetWindowPos(W.hwnd_of(win), -1, 0, 0, 0, 0, 0x13)
        cardwin = self.child()
        self.root.update()
        card = CW.Win()
        card.hwnd = W.hwnd_of(cardwin)
        card.own(W.hwnd_of(self.root))
        card.sync_topmost(True)
        self.app.apply_topmost()
        for win in self.windows() + [cardwin]:
            self.assertTrue(self.above(self.popup_hwnd, W.hwnd_of(win)))
            self.assertTrue(W.topmost_matches(W.hwnd_of(win), True))
        self.assert_pet_above_furniture()
        self.assertEqual(self.u.GetWindowLongW(self.popup_hwnd, -20), style)
        self.assertEqual(self.u.GetForegroundWindow(), fg)

    def test_hidden_popup_cache_is_ignored(self):
        self.popup.withdraw()
        with patch.object(W, 'z_below', wraps=W.z_below) as move:
            W.yield_to_system_popups(W.hwnd_of(self.root))
            move.assert_not_called()
        self.assertTrue(W.topmost_matches(W.hwnd_of(self.root), True))

    def test_normal_window_never_demotes_pet(self):
        self.u.SetWindowPos(self.popup_hwnd, -2, 0, 0, 0, 0, 0x13)
        self.app.apply_topmost()
        self.assertTrue(W.topmost_matches(W.hwnd_of(self.root), True))
        self.assertTrue(self.above(W.hwnd_of(self.root), self.popup_hwnd))

    def test_stable_popup_order_does_not_churn(self):
        self.app.apply_topmost()
        self.root.update()
        self.app.apply_topmost()
        with patch.object(W, 'z_below', wraps=W.z_below) as move:
            self.app.apply_topmost()
            move.assert_not_called()

    def test_observed_native_menu_and_tray_classes_are_protected(self):
        self.assertTrue({'#32768', 'TopLevelWindowForOverflowXamlIsland', 'NotifyIconOverflowWindow'} <= W.SYSTEM_POPUP_CLASSES)
        self.assertNotIn('Chrome_WidgetWin_1', W.SYSTEM_POPUP_CLASSES)
        self.assertNotIn('TkTopLevel', W.SYSTEM_POPUP_CLASSES)


if __name__ == '__main__':
    unittest.main(verbosity=2)
