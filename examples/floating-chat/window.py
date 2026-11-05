#!/usr/bin/env python3
# ⚠️ 本文件由 dsh-see-now/scripts/sync-window.mjs 生成，请勿手改（要改请改上游 dsh-watch-together）
"""陪看悬浮窗：不铺全屏背景图，实时抓窗口背后的桌面并模糊成液态玻璃。

三层，各自不知道对方的实现：

    glass_geometry.py   一套尺寸的全部贴图（不可变，尺寸/形状变了换一个新对象）
    glass_cpu.py        CPU 合成：抓屏 → 模糊 → 边缘折射 → 内框透镜 → 染色 → 色散
    glass_gpu.py        同一件事搬到 GPU（moderngl / OpenGL 3.3+）
    window.py           这个文件：Tk 窗口、聊天流、文字层、拖动/缩放/折叠/改名

`glass_capture.py` 是两条渲染路径共用的抓屏与运动判定 —— 历史上同一条判断
在 CPU / GPU 各写一份，于是同一个 bug 也要修两遍（#39、#48）。

关键点：
- Windows 10 2004+ 的 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)：让本窗口
  从屏幕捕获里消失，于是抓自己所在区域时抓到的是「背后的桌面」，不会递归。
  代价是远程桌面/录屏/截图里整窗也看不见；用 `glass: solid` 切纯色底板，
  不抓屏、不设 WDA，任何捕获方式都能看到。
- 抓到的背景按需重合成（静止时跳帧），所以是实时模糊，不是静态截图。
- 这不是 DWM Acrylic；Acrylic 需要系统「透明效果」开启，这里是软件实时模糊。

渲染后端：默认 CPU。`DSH_GLASS_NATIVE=1` 或 `DSH_GLASS_GPU=1` 走 GPU。
"""
import ctypes
import json
import os
import queue
import subprocess
import threading
import time
from ctypes import wintypes
from pathlib import Path

# 必须在 import tkinter / 创建任何窗口之前声明 per-monitor v2 DPI 感知。
_u = ctypes.windll.user32
try:
    _u.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    _u.SetProcessDpiAwarenessContext.restype = ctypes.c_bool
    _u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    pass

try:
    ctypes.windll.winmm.timeBeginPeriod(1)
except Exception:
    pass

# ---------------------------------------------------------------- 依赖预检
#
# 必须在 import mss / numpy / PIL / glass_* **之前**：pythonw 没有控制台，
# 导入失败时 Python 直接退出，用户只看到"窗口没出来"，连一行提示都没有（#76）。
# 这里用 ctypes 弹 MessageBox（不依赖 tkinter —— 它也可能缺），并把原因落盘。

def _missing_deps() -> list:
    missing = []
    for module, package in (("tkinter", "tkinter（Python 安装时勾选 tcl/tk）"),
                            ("mss", "mss"), ("numpy", "numpy"), ("PIL", "pillow")):
        try:
            __import__(module)
        except Exception:
            missing.append(package)
    return missing


def _die_missing(missing: list) -> None:
    log_path = Path.home() / ".dsh" / "watch-window-error.log"
    text = ("悬浮窗启动失败：缺少 " + "、".join(missing) + "\n\n"
            + "装一次就好：\n    pip install pillow numpy mss\n\n"
            + f"详情：{log_path}")
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(text + "\n", encoding="utf-8")
    except Exception:
        pass
    try:
        ctypes.windll.user32.MessageBoxW(None, text, "dsh-watch-together", 0x10)
    except Exception:
        print(text, flush=True)
    raise SystemExit(2)


if __name__ == "__main__":
    _missing = _missing_deps()
    if _missing:
        _die_missing(_missing)

import tkinter as tk

import mss
import numpy as np
from PIL import Image, ImageTk

from glass_capture import CaptureSource, MotionTracker
from glass_cpu import CpuRenderer
from glass_geometry import (
    BAR_FRAC, BAR_THICK, BAR_Y, DEFAULT_H, DEFAULT_W, KEY, MESSAGE_SLOTS,
    MIC_SIZE, MIN_H, MIN_W, Geometry, collapsed_height, shapes_for,
)
from window_widgets import ChatFeed, Fonts, TextLayer

try:  # 悬浮窗接口：插件写 window-events.jsonl，窗口回 window-outbox.jsonl
    from window_protocol import WindowProtocol
except Exception:
    WindowProtocol = None


def _max_fps() -> int:
    """目标帧率上限，默认 60；120Hz 玻璃可显式开回 120。

    120fps 的一帧预算只有 8.3ms，而单次 mss 抓屏约 7ms，再叠 CPU 合成，
    预算已经贴边；低配机/高分屏/动态桌面会一直落在“差一点来得及”的区间。
    默认 60fps 把预算抬到 16.6ms，显示线程也不再用 4ms 定时器空转。
    """
    try:
        fps = int(os.environ.get("DSH_GLASS_MAX_FPS", "60"))
    except (TypeError, ValueError):
        fps = 60
    return max(30, min(120, fps))


MAX_FPS = _max_fps()
# 主线程按目标帧率唤醒；旧值固定 4ms（250Hz），后台却按 120fps 合成，
# 抓屏 + 合成一旦超过 8.3ms，主线程还在空转堆积 after 回调。
INTERVAL_MS = max(4, int(1000 / MAX_FPS))
# 静止画面下「有没有变」只能靠抓屏看，单次 grab ~7ms；空转按 60fps 就是 40% 单核。
# 降到 30fps 探针，有变化时 idle 立刻归零、下一拍恢复全速。
PROBE_FPS = 30

# 仅用于文档截图/CI 视觉检查：暂停抓屏并把 WDA 关掉，窗口才会出现在截图里
PREVIEW = os.environ.get("DSH_GLASS_PREVIEW") == "1"
# 文档截图：正常抓屏 2.5 秒后暂停并取消 WDA，保留最后一帧玻璃
SNAPSHOT = os.environ.get("DSH_GLASS_SNAPSHOT") == "1"
# GPU：native 表示全分辨率采样（边缘透镜没有 1/4 放大的像素感）
NATIVE = os.environ.get("DSH_GLASS_NATIVE") == "1"
USE_GPU = NATIVE or os.environ.get("DSH_GLASS_GPU") == "1"
# 气泡底板（和 glass_geometry.BUBBLE_PLATE 同一个开关）：关掉 = 回到逐字翻色，
# 只用来拍新旧对比图，正常别动。
PLATE = os.environ.get("DSH_GLASS_PLATE", "1") != "0"

HERE = Path(__file__).resolve().parent


class _RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


# ---------------------------------------------------------------- 路径与配置

def cache_dir() -> Path:
    d = os.environ.get("DSH_VIDEO_CACHE_DIR")
    if d:
        return Path(d)
    local = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" and local:
        return Path(local) / "dsh-video-storyboard" / "cache"
    return Path(os.environ.get("XDG_CACHE_HOME") or "~/.cache").expanduser() / "dsh-video-storyboard"


CHAT_FILE = cache_dir() / "chat.jsonl"
CONFIG = Path(os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")) / "watch-window.json"
MIC_SCRIPT = HERE / "mic.py"

# **心跳**：插件侧靠它区分「进程还在」和「窗口真的在画」。只看 pid 不够 ——
# pid 会被复用，进程也可能活着但界面已经卡死，那样宿主会永远认为窗还开着，
# 于是再也不重开（see-now issue #2 第 3 条）。每秒最多写一次。
HEARTBEAT = cache_dir() / "window-heartbeat"
HEARTBEAT_EVERY = 1.0


def read_config() -> dict:
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def write_config(patch: dict) -> None:
    cfg = read_config()
    cfg.update(patch or {})
    try:
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, CONFIG)
    except Exception:
        pass


def capturable() -> bool:
    """录屏 / 截图能不能拍到窗口。

    默认**不能**：走 `WDA_EXCLUDEFROMCAPTURE`，窗口不会出现在截图、直播、共享屏幕里。
    要给别人看效果就在 `~/.dsh/watch-window.json` 写 `{ "capturable": true }`。
    环境变量 `DSH_GLASS_WDA=0` 只对这一次启动有效（插件拉起窗口时不传环境变量）。
    """
    if os.environ.get("DSH_GLASS_WDA") == "0":
        return True
    try:
        return read_config().get("capturable") is True
    except Exception:
        return False


# 远程控制软件不一定置 SM_REMOTESESSION；它们的窗口/类名是最稳的旁证。
# 命中任意一个就按 remote 处理，用 solid 底板，保证对面能看到整窗。
REMOTE_MARKS = (
    "gameviewer", "todesk", "sunlogin", "anydesk", "teamviewer",
    "rustdesk", "parsec", "uu远程", "向日葵",
)


def remote_capture_likely() -> bool:
    """当前是不是远程/捕获环境：RDP 标志位 + 常见远程软件窗口。"""
    try:
        if ctypes.windll.user32.GetSystemMetrics(0x1000):  # SM_REMOTESESSION
            return True
    except Exception:
        pass
    try:
        u = ctypes.windll.user32
        u.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        u.GetWindowTextLengthW.restype = ctypes.c_int
        u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.GetWindowTextW.restype = ctypes.c_int
        u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        u.GetClassNameW.restype = ctypes.c_int
        u.IsWindowVisible.argtypes = [wintypes.HWND]
        u.IsWindowVisible.restype = wintypes.BOOL
        hit = [False]

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def visit(hwnd, _lparam):
            if not u.IsWindowVisible(hwnd):
                return True
            n = u.GetWindowTextLengthW(hwnd)
            title = ""
            if n > 0:
                buf = ctypes.create_unicode_buffer(n + 1)
                u.GetWindowTextW(hwnd, buf, n + 1)
                title = buf.value
            cls = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(hwnd, cls, 256)
            hay = (title + " " + cls.value).lower()
            if any(mark in hay for mark in REMOTE_MARKS):
                hit[0] = True
                return False
            return True

        u.EnumWindows(visit, 0)
        return hit[0]
    except Exception:
        return False


def glass_mode() -> str:
    """玻璃背景模式：live（实时抓屏，默认）/ solid（纯色底板）。

    `WDA_EXCLUDEFROMCAPTURE` 会让窗口在远程桌面、OBS、截图工具里**整窗消失**
    （微软文档：“Everywhere else, the window does not appear at all”）。
    本机看起来正常，因为 mss 抓到的是窗口背后的像素；远程端却连文字都看不到。

    - `{ "glass": "solid" }`：不抓屏、不设 WDA，用纯色底板；任何捕获方式都能看到；
    - `{ "glass": "live" }`：原来的实时玻璃；
    - 不写 / `auto`：检测 `SM_REMOTESESSION` 和常见远程软件窗口，命中就用 solid。
    """
    if os.environ.get("DSH_GLASS_SOLID") == "1":
        return "solid"
    if os.environ.get("DSH_GLASS_LIVE") == "1":
        return "live"
    try:
        mode = str(read_config().get("glass") or "").strip().lower()
    except Exception:
        mode = ""
    if mode in ("solid", "live"):
        return mode
    # 空值 / auto：RDP 标志位或常见远程软件窗口任一命中，就用 solid。
    if remote_capture_likely():
        return "solid"
    return "live"


def append_user(text: str) -> None:
    CHAT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CHAT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps({"role": "user", "text": text, "at": int(time.time() * 1000)},
                           ensure_ascii=False) + "\n")


def asr_python() -> str:
    """麦克风用 ASR 的 Python，不是带 tkinter 的这个。"""
    for key in ("DSH_ASR_PYTHON", "DSH_FLOAT_PYTHON"):
        v = os.environ.get(key)
        if v:
            return v
    return "python.exe" if os.name == "nt" else "python3"


def display_hz() -> int:
    try:
        u = ctypes.windll.user32
        g = ctypes.windll.gdi32
        dc = u.GetDC(0)
        hz = int(g.GetDeviceCaps(dc, 116))
        u.ReleaseDC(0, dc)
        return hz if hz > 0 else 60
    except Exception:
        return 60


# ---------------------------------------------------------------- 窗口

# 虚拟桌面 = 所有显示器拼起来的物理像素范围。主屏固定从 (0,0) 起算，
# 第二块屏可能在它左边 / 上面，那时坐标本来就是负的 —— 只拿
# winfo_screenwidth()（= 主屏宽度）当边界，窗口就永远离不开主屏（#8）。
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79


def virtual_bounds(fallback_w=0, fallback_h=0):
    """(x, y, w, h)：虚拟桌面左上角与尺寸，物理像素。

    取不到（非 Windows / 远程会话偶尔返回 0）就退回主屏 (0, 0, w, h)。
    """
    try:
        u = ctypes.windll.user32
        vx = int(u.GetSystemMetrics(SM_XVIRTUALSCREEN))
        vy = int(u.GetSystemMetrics(SM_YVIRTUALSCREEN))
        vw = int(u.GetSystemMetrics(SM_CXVIRTUALSCREEN))
        vh = int(u.GetSystemMetrics(SM_CYVIRTUALSCREEN))
        if vw > 0 and vh > 0:
            return vx, vy, vw, vh
    except Exception:
        pass
    return 0, 0, int(fallback_w or 0), int(fallback_h or 0)


class LiveGlass:
    def __init__(self):
        cfg = read_config()
        raw_name = cfg.get("name")
        self.name = (raw_name.strip()[:24] if isinstance(raw_name, str) and raw_name.strip()
                     else "陪看")

        self.feed = ChatFeed(CHAT_FILE)
        self._mic_proc = None
        self._protocol = WindowProtocol() if WindowProtocol is not None else None
        self._collapsed = False
        self._saved_h = DEFAULT_H
        self._snapshot_done = False
        self._title_entry = None
        self._title_item = None
        self._editing = False
        self._hidden = False
        self._cfg_key = None

        self.root = tk.Tk()
        self.root.withdraw()
        self.root.overrideredirect(True)
        self.root.title(self.name)
        self.root.attributes("-topmost", True)
        self.root.configure(bg=KEY)
        self.root.attributes("-transparentcolor", KEY)
        self.fonts = Fonts(self.root)

        self._sw, self._sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        # 主屏尺寸只用来算默认位置；能拖到哪、抓屏能抓到哪，看虚拟桌面（多显示器）
        self._vx, self._vy, self._vw, self._vh = virtual_bounds(self._sw, self._sh)
        w, h, x, y = self._initial_geometry(cfg.get("geometry"))
        self._x, self._y = x, y
        self._geo = Geometry.for_size(w, h)
        # 入场：从下方 22px 滑上来（不碰 -alpha，避免和抠色冲突）
        self._intro_target_y = y
        self._intro_y = y + 22
        self.root.geometry(f"{w}x{h}+{x}+{self._intro_y}")

        self.canvas = tk.Canvas(self.root, width=w, height=h, bg=KEY,
                                highlightthickness=0, bd=0)
        self.canvas.pack(fill="both", expand=True)
        self.text = TextLayer(self.root, self.canvas, self.fonts)

        self._img = None
        self._last_frame = None
        self._collapsed_frame = None
        self._bg = None
        self._entry = None
        self._entry_item = None
        self._bar = None
        self._bar_len = 0
        self._bar_color = "#b8cbe0"
        self._aux_at = 0.0

        self._hwnd = None
        self._excluded = False
        # 录屏模式（capturable）下 mss 会抓到窗口自己，必须每帧挖掉，见 fill_own_rect。
        # 缓存起来：读配置是磁盘 IO，不能每帧做。
        self._cappable = capturable()
        # solid：远程/录屏下 WDA 会让整窗在对面消失；不抓屏、不设 WDA。
        self._solid = glass_mode() == "solid"
        self._drag = None
        self._resize = None
        self._preview_at = 0.0
        # Entry 的真光标被关掉（insertwidth=0），画面上那条线是自己画的，
        # 所以闪烁也得自己来。_caret_job 存 after 的 id，重排时取消，避免叠定时器。
        self._caret_on = True
        self._caret_job = None
        # 长消息展开：被截断的气泡点一下独占整个消息区，再点收起。
        # 存的是消息身份 (role, text, at) 而不是槽位下标 —— 新消息进来会让
        # 同一条消息换槽，存下标会变成"展开的是另一条"。
        self._expanded = None
        self._fit_clipped = False

        self._q: queue.Queue = queue.Queue(maxsize=1)
        self._stop = threading.Event()
        self._pause = threading.Event()
        self._geo_lock = threading.Lock()
        self._source = CaptureSource((self._sw, self._sh), cappable=self._cappable,
                                     solid=self._solid,
                                     # 窗口落在副屏时，抓屏范围要按虚拟桌面钳
                                     bounds=(self._vx, self._vy, self._vw, self._vh))
        self._renderer = self._make_renderer(self._geo)
        self._worker = threading.Thread(target=self._work, daemon=True)

        self._hz = display_hz()
        self._target_fps = min(MAX_FPS, self._hz)
        self._ema = 1.0 / max(1, self._target_fps)
        self._draw_ms = 0.0       # Tk 主线程实际绘制耗时，用来给 after 留余量
        self._last_motion = 0.0

        self.feed.reload()
        self._layout()

        self.root.deiconify()
        self.root.update_idletasks()
        self.text.refresh()
        self._set_exclude(not capturable() and not self._solid)
        self._worker.start()
        self.root.lift()
        self.root.after(80, self.root.lift)
        self.root.after(120, self.root.focus_set)
        self.root.after(60, self._tick)
        self.root.after(30, lambda: self._intro_step(0))
        self.root.after(250, self._poll_chat)
        self.root.after(1200, self._keep_on_top)
        if SNAPSHOT:
            self.root.after(2600, self._snapshot_mode)

    # ---- 渲染后端 ----

    def _make_renderer(self, geo: Geometry):
        if USE_GPU:
            try:
                from glass_gpu import GpuRenderer
                return GpuRenderer(geo, MotionTracker(), native=NATIVE)
            except Exception as exc:
                print("GPU 初始化失败，回落到 CPU:", repr(exc), flush=True)
        return CpuRenderer(geo)

    # ---- 尺寸 ----

    def _initial_geometry(self, geo):
        sw, sh = self._sw, self._sh
        w, h = DEFAULT_W, DEFAULT_H
        # 默认位置仍是主屏居中偏右下（和以前一致）；恢复位置按虚拟桌面钳位，
        # 否则上次存在第二块屏上的坐标（负数）会被拉回主屏左上角。
        x, y = max(40, sw - w - 80), max(40, (sh - h) // 2 - 40)
        try:
            size, rest = geo.split("+", 1)
            pw, ph = (int(v) for v in size.split("x"))
            px, py = (int(v) for v in rest.split("+")[:2])
            w = max(MIN_W, min(sw - 40, pw))
            h = max(MIN_H, min(sh - 40, ph))
            x = max(self._vx, min(self._vx + self._vw - w, px))
            y = max(self._vy, min(self._vy + self._vh - h, py))
        except Exception:
            pass
        return w, h, x, y

    def _sync_screens(self):
        """刷新虚拟桌面范围：接/拔显示器、改分辨率后不用重开窗口。

        拖动/缩放开始前调一次就够（GetSystemMetrics 很便宜，但没必要每帧问）。
        """
        vx, vy, vw, vh = virtual_bounds(self._sw, self._sh)
        if vw > 0 and vh > 0:
            self._vx, self._vy, self._vw, self._vh = vx, vy, vw, vh
            if getattr(self, "_source", None) is not None:
                self._source.bounds = (vx, vy, vw, vh)
        return self._vx, self._vy, self._vw, self._vh

    def _set_geometry(self, geo: Geometry) -> None:
        """换一套几何：渲染器跟着换，静态跳帧的签名作废。"""
        self._geo = geo
        self._renderer.set_geometry(geo)
        self.canvas.config(width=geo.width, height=geo.height)

    def _apply_shapes(self, shapes) -> None:
        """气泡宽度/高度变了：尺寸相关的遮罩/折射图直接复用，只重算框。"""
        with self._geo_lock:
            self._set_geometry(self._geo.with_shapes(shapes))

    # ---- 窗口外观 ----

    def _intro_step(self, n: int) -> None:
        try:
            if n >= 6:
                self._y = self._intro_target_y
            else:
                self._y = self._intro_target_y + int(22 * (1 - (n + 1) / 6.0))
            self.root.geometry(f"{self._geo.width}x{self._geo.height}+{self._x}+{self._y}")
        except Exception:
            pass
        if n < 6:
            self.root.after(26, lambda: self._intro_step(n + 1))

    def _keep_on_top(self) -> None:
        """DSH 等置顶窗口被激活后会把悬浮窗压下去；定时重新抬到最上层。"""
        try:
            if not self._hidden:
                self.root.attributes("-topmost", True)
                self.root.lift()
        except Exception:
            pass
        try:
            self.root.after(1800, self._keep_on_top)
        except Exception:
            pass

    # ---- 协议 ----

    def _render_event(self, event) -> None:
        if not isinstance(event, dict):
            return
        if event.get("type") in ("message", "meta"):
            self.feed.add(ChatFeed.parse(json.dumps(event, ensure_ascii=False)))
            self._refresh_feed()
        elif event.get("type") == "control":
            self._apply_control(event)

    def _apply_control(self, event) -> None:
        action = str(event.get("action") or "")
        value = event.get("value")
        try:
            if action == "rename" and str(value or "").strip():
                self.name = str(value).strip()[:24]
                self.root.title(self.name)
                write_config({"name": self.name})
                self._refresh_feed()
            elif action == "collapse" and not self._collapsed:
                self.toggle_collapse()
            elif action == "expand" and self._collapsed:
                self.toggle_collapse()
            elif action == "hide":
                self._hidden = True
                write_config({"hidden": True})
                self.root.withdraw()
            elif action == "show":
                self._hidden = False
                write_config({"hidden": False})
                self.root.deiconify()
                self.root.attributes("-topmost", True)
        except Exception:
            pass

    def _drain_protocol(self) -> list:
        if self._protocol is None:
            return []
        try:
            return self._protocol.read_events()
        except Exception:
            return []

    def _replay_protocol(self) -> None:
        if self._protocol is None:
            return
        try:
            for event in self._protocol.reset_events(60):
                self._render_event(event)
        except Exception:
            pass

    # ---- 聊天轮询 ----

    def _poll_chat(self) -> None:
        try:
            self._sync_visible()
            for event in self._drain_protocol():
                self._render_event(event)
            if self._mic_proc is not None and self._mic_proc.poll() is not None:
                self._mic_proc = None
                self.feed.status = ""
                self._refresh_feed()
            if self.feed.poll():
                self._collapse_expanded()
                self._refresh_feed()
        except Exception as exc:
            print("chat poll error", exc, flush=True)
        if not self._stop.is_set():
            self.root.after(250, self._poll_chat)

    def _sync_visible(self) -> None:
        try:
            st = CONFIG.stat()
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            key = None
        if key == self._cfg_key:
            return
        self._cfg_key = key
        want = bool(read_config().get("hidden"))
        if want == self._hidden:
            return
        self._hidden = want
        try:
            if want:
                self.root.withdraw()
            else:
                self.root.deiconify()
                self.root.attributes("-topmost", True)
                self.root.lift()
        except Exception:
            self._hidden = not want

    # ---- 输入 ----

    def _send(self, _event=None):
        if self._entry is None:
            return "break"
        text = self._entry.get().strip()
        if not text:
            return "break"
        try:
            append_user(text)
        except Exception as exc:
            self.feed.status = f"写不进去：{exc}"
            self._refresh_feed()
            return "break"
        try:
            self._entry.delete(0, "end")
        except Exception:
            pass
        try:
            if self._protocol is not None:
                self._protocol.action("say", text=text)
        except Exception:
            pass
        self._render_input()
        self.root.after(40, self._poll_chat)
        return "break"

    def _wheel(self, e):
        if self.feed.scroll(1 if e.delta > 0 else -1):
            self._collapse_expanded()
            self._refresh_feed()

    def _toggle_mic(self):
        if self._mic_proc is not None and self._mic_proc.poll() is None:
            self._stop_mic()
            return
        if not MIC_SCRIPT.exists():
            self.feed.status = "找不到 mic.py"
            self._refresh_feed()
            return
        try:
            self._mic_proc = subprocess.Popen(
                [asr_python(), str(MIC_SCRIPT), "--engine", "local"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=0x08000000 if os.name == "nt" else 0,
            )
            self.feed.status = "录音中"
        except Exception as exc:
            self.feed.status = f"麦起不来：{exc}"
        self._refresh_feed()

    def _stop_mic(self):
        p = self._mic_proc
        self._mic_proc = None
        self.feed.status = ""
        if p is not None and p.poll() is None:
            try:
                p.terminate()
            except Exception:
                pass
        self._refresh_feed()

    CARET_MS = 530          # 和 Windows 默认的光标闪烁周期一致
    CARET_PAD = 3           # 光标右边至少留几个字符，别让它贴着可见段右缘

    def _visible_input(self, text: str, maxw: int, caret: int):
        """返回能放进 maxw 的那一段，以及光标在这一段里的字符下标。

        原来只从左边砍（`text = text[1:]`），等于永远把尾巴留在视野里：光标移到
        句首时会被推到看不见的地方。改成以光标为锚点开窗 —— 先保证光标可见，
        再尽量往两边补字。

        光标右边留 CARET_PAD 个字符：不留的话往左移动时光标会一直贴着右缘，
        看不出右边还有内容（20 字符文本 / 10 字符窗口实测，caret=10 和 caret=17
        的可见段右端都正好停在光标上）。
        """
        font = self.fonts.get(11)
        if font.measure(text) <= maxw:
            return text, caret
        lo = min(caret, len(text))
        hi = min(len(text), lo + self.CARET_PAD)
        # 右边余量优先：先确保 caret..caret+PAD 进得去，再往左补已经打出来的内容
        while hi > lo and font.measure(text[lo:hi]) > maxw:
            hi -= 1
        while lo > 0 and font.measure(text[lo - 1:hi]) <= maxw:
            lo -= 1
        while hi < len(text) and font.measure(text[lo:hi + 1]) <= maxw:
            hi += 1
        while lo > 0 and font.measure(text[lo - 1:hi]) <= maxw:
            lo -= 1
        return text[lo:hi], caret - lo

    def _render_input(self) -> None:
        """输入文字画在 Canvas 上；Entry 只负责 IME/键盘，永远不可见。"""
        if self._entry is None:
            return
        c = self.canvas
        c.delete("inputtext", "inputcursor")
        try:
            text = self._entry.get()
            focused = self.root.focus_get() is self._entry
            # 光标位置必须读 Entry 的真实插入点：原来按整段文字宽度算，等于把
            # 线永远钉在末尾，左右键移动时画面上的光标根本不动。
            caret = self._entry.index("insert")
        except Exception:
            text, focused, caret = "", False, 0
        x0, y0, x1, y1, _r = self._geo.input_shape
        x, y = x0 + 84, y0 + 27
        maxw = max(60, x1 - x0 - 100)
        cx = None
        if not text and not focused:
            self.text.draw(x, y, "在这里跟它说话…", anchor="w", fill="#8e9db2",
                           size=11, tags=("inputtext", "inputzone"))
        elif text:
            font = self.fonts.get(11)
            shown, caret_in = self._visible_input(text, maxw, caret)
            self.text.draw(x, y, shown, anchor="w", fill="#eef6ff",
                           size=11, tags=("inputtext", "inputzone"))
            if focused:
                cx = x + font.measure(shown[:max(0, caret_in)])
        elif focused:
            cx = x
        if cx is not None and self._caret_on:
            c.create_line(cx + 1, y - 9, cx + 1, y + 9,
                          fill="#b9d7ff", width=1, tags=("inputcursor",))
        self._schedule_caret(cx is not None)
        self.text.refresh()

    def _schedule_caret(self, active: bool) -> None:
        """只有输入框拿着焦点时才跑闪烁定时器；失焦就停，不白烧 after。"""
        if self._caret_job is not None:
            try:
                self.root.after_cancel(self._caret_job)
            except Exception:
                pass
            self._caret_job = None
        if not active:
            self._caret_on = True
            return
        self._caret_job = self.root.after(self.CARET_MS, self._blink_caret)

    def _blink_caret(self) -> None:
        self._caret_job = None
        if self._entry is None:
            return
        try:
            if self.root.focus_get() is not self._entry:
                self._caret_on = True
                return
        except Exception:
            return
        self._caret_on = not self._caret_on
        self._render_input()

    def _on_input_key(self, _e=None):
        # 打字期间光标恒亮：这时闪烁反而碍事，和系统输入框一致
        self._caret_on = True
        self._render_input()
        return None

    def _focus_input(self, _e=None):
        try:
            self._entry.focus_force()
            self._entry.icursor("end")
        except Exception:
            pass
        self._caret_on = True
        self._render_input()

    # ---- 改名 ----

    def _edit_title(self, _event=None):
        if self._editing:
            return "break"
        self._editing = True
        if self._title_entry is None:
            self._title_entry = tk.Entry(self.root, font=self.fonts.spec(15), relief="flat",
                                         bd=0, bg="#1b2330", fg="#f7fbff",
                                         insertbackground="#f7fbff")
            self._title_entry.bind("<Return>", self._commit_title)
            self._title_entry.bind("<Escape>", self._cancel_title)
            self._title_entry.bind("<FocusOut>", self._commit_title)
        self._title_entry.delete(0, "end")
        self._title_entry.insert(0, self.name)
        if self._title_item is not None:
            self.canvas.delete(self._title_item)
        self._title_item = self.canvas.create_window(68, 38, anchor="w",
                                                     window=self._title_entry, width=180)
        self._title_entry.focus_set()
        self._title_entry.select_range(0, "end")
        return "break"

    def _commit_title(self, _event=None):
        if not self._editing:
            return
        self._editing = False
        text = self._title_entry.get().strip()
        if self._title_item is not None:
            self.canvas.delete(self._title_item)
            self._title_item = None
        if text and text != self.name:
            self.name = text[:24]
            self.root.title(self.name)
            write_config({"name": self.name})
            try:
                if self._protocol is not None:
                    self._protocol.action("rename", value=self.name)
            except Exception:
                pass
        self._refresh_feed()
        return "break"

    def _cancel_title(self):
        self._editing = False
        if self._title_item is not None:
            self.canvas.delete(self._title_item)
            self._title_item = None
        self._refresh_feed()
        return "break"

    # ---- 折叠 ----

    def toggle_collapse(self, _event=None):
        # 先读真实坐标再切高度：_x/_y 只是启动时的缓存，拖动/缩放后已过期。
        self._sync_pos()
        self._collapsed = not self._collapsed
        if self._collapsed:
            self._saved_h = self._geo.height
            # 先换成折叠尺寸的几何，再按它裁上一帧，否则圆角遮罩还是整窗高度
            self._set_geometry(Geometry.for_size(self._geo.width, collapsed_height()))
            self._collapsed_frame = self._geo.collapsed_frame(self._last_frame)
            self.root.geometry(f"{self._geo.width}x{self._geo.height}+{self._x}+{self._y}")
            self._layout()
        else:
            self._collapsed_frame = None
            self._set_geometry(Geometry.for_size(self._geo.width, self._saved_h))
            self.root.geometry(f"{self._geo.width}x{self._geo.height}+{self._x}+{self._y}")
            self._layout(seed=True)
        try:
            if self._protocol is not None:
                self._protocol.action("collapse" if self._collapsed else "expand")
        except Exception:
            pass

    # ---- 气泡布局 ----

    def _fit_lines(self, text, size, max_width, max_height) -> list[str]:
        """按框宽/框高折行并截断，避免文字溢出气泡。"""
        font = self.fonts.get(size)
        measure = font.measure
        ls = max(1, font.metrics("linespace"))
        max_lines = max(1, int(max_height // ls))
        no_start = "，。、；：！？）》」』…,.;:!?)]}"
        lines = []
        for para in str(text).splitlines() or [""]:
            cur = ""
            for ch in para:
                if not cur or measure(cur + ch) <= max_width:
                    cur += ch
                elif ch in no_start:
                    cur += ch          # 标点不能单独掉到下一行
                else:
                    lines.append(cur)
                    cur = ch
            lines.append(cur)
        # 调用方要知道这条到底被砍了没有：省略号自己看不出是"全文正好以…结尾"
        # 还是"被截断了"，而展开入口只该给真被砍的那几条。
        self._fit_clipped = len(lines) > max_lines
        if self._fit_clipped:
            lines = lines[:max_lines]
            last = lines[-1]
            while last and measure(last + "…") > max_width:
                last = last[:-1]
            lines[-1] = (last + "…") if last else "…"
        return lines or [""]

    @staticmethod
    def _msg_key(msg):
        """消息身份：(role, text, at)，和 ChatFeed.add 的去重键一致。"""
        return (msg.get("role"), msg.get("text"), msg.get("at"))

    def _expanded_index(self, shown):
        """当前展开的那条在 shown 里的下标；已经滚出视野就返回 None。"""
        if self._expanded is None:
            return None
        for i, msg in enumerate(shown):
            if self._msg_key(msg) == self._expanded:
                return i
        return None

    def _toggle_expand(self, key) -> None:
        """点截断的气泡：展开成独占整个消息区；再点收起。"""
        self._expanded = None if self._expanded == key else key
        self._layout()

    def _collapse_expanded(self) -> None:
        """新消息进来或翻页时自动收起：否则盯着一条老消息，新消息看不见。"""
        self._expanded = None

    def _message_shapes(self, shown):
        """四个固定大框换成按正文文字测量的聊天气泡。

        时间戳不算进气泡：它贴在气泡上方，气泡只包正文。先按最大可用宽度折行，
        再取实际最长行的宽度；短消息不会撑满整行。
        """
        w, h = self._geo.width, self._geo.height
        base = shapes_for(w, h)
        left, right = base[0][0], base[0][2]
        max_bubble = min(right - left, max(240, int((right - left) * 0.72)))
        min_bubble = min(110, max_bubble)
        pad = 18
        fbody = self.fonts.get(11)
        fstamp = self.fonts.get(9)
        ls = max(1, fbody.metrics("linespace"))
        shapes, infos = [], []
        # 展开态：这条独占 4 个槽位的纵向范围，其余三条让位。槽位网格本身不动
        # （chat_layout 仍是 h 的纯函数），只是把"4 槽各放 1 条"换成"1 条占满"，
        # 气泡边界照样受 base 约束，不会压到输入框。
        expanded_at = self._expanded_index(shown)
        for i in range(MESSAGE_SLOTS):
            if expanded_at is not None and i != expanded_at:
                shapes.append((0, 0, 0, 0, 0))     # 展开态下其他消息让位
                continue
            if i >= len(shown):
                shapes.append((0, 0, 0, 0, 0))     # 没有这条消息：不画框
                continue
            msg = shown[i]
            x0, y0, x1, y1, _r = base[i]
            if expanded_at is not None:
                y0, y1 = base[0][1], base[MESSAGE_SLOTS - 1][3]
            slot_h = y1 - y0
            is_user = str(msg.get("role") or "").lower() in ("user", "me", "human")
            stamp = str(msg.get("stamp") or "")
            stamp_h = fstamp.metrics("linespace") if stamp else 0
            body_avail = max(12, slot_h - stamp_h)
            content_max = max(80, max_bubble - 2 * pad)
            lines = self._fit_lines(msg.get("text") or "", 11, content_max, body_avail)
            inner = max([0] + [fbody.measure(line) for line in lines])
            bw = min(max_bubble, max(min_bubble, inner + 2 * pad))
            bh = min(body_avail, max(ls + 16, len(lines) * ls + 16))
            by0 = y0 + stamp_h
            by1 = min(y1, by0 + bh)
            if is_user:
                bx1 = right
                bx0 = bx1 - bw
                tx, ta = bx1 - pad, "ne"
            else:
                bx0 = left
                bx1 = bx0 + bw
                tx, ta = bx0 + pad, "nw"
            shape = (bx0, by0, bx1, by1, min(26, max(16, bh // 3)))
            shapes.append(shape)
            infos.append({
                "shape": shape, "is_user": is_user, "stamp": stamp,
                "tx": tx, "ta": ta, "lines": lines,
                "ty": by0 + max(4, (bh - len(lines) * ls) // 2),
                "stamp_y": y0, "ls": ls,
                # 截断的气泡要能点开，也要看得出"这还没完"
                "clipped": self._fit_clipped,
                "expanded": expanded_at == i,
                "key": self._msg_key(msg),
            })
        shapes.extend(base[MESSAGE_SLOTS:])
        return shapes, infos

    # ---- 布局 ----

    def _ensure_entry(self) -> None:
        """Entry 只建一次：每次消息都销毁重建会丢输入法状态和草稿光标。"""
        if self._entry is not None:
            return
        self._entry = tk.Entry(self.root, bg=KEY, fg=KEY, insertbackground=KEY,
                               relief="flat", bd=0, font=self.fonts.spec(11),
                               insertwidth=0, highlightthickness=0)
        self._entry.bind("<KeyRelease>", self._on_input_key)
        self._entry.bind("<Return>", self._send)
        self._entry.bind("<FocusIn>", lambda _e: self._render_input())
        self._entry.bind("<FocusOut>", lambda _e: self._render_input())
        # 插入点还能被鼠标和选择改动，这些不发 KeyRelease：不补这几个，点一下
        # 输入框中间，画面上的光标就跟不过去。after_idle 等 Entry 自己先处理完。
        for seq in ("<ButtonRelease-1>", "<B1-Motion>", "<<Selection>>"):
            self._entry.bind(seq, lambda _e: self.root.after_idle(self._on_input_key), add="+")

    def _layout(self, seed: bool = False) -> None:
        """整窗重排：标题栏 + 气泡 + 输入区 + 滚动条，然后把上一帧贴回去。

        `seed=True` 时按新尺寸缩放上一帧先顶着（缩放/展开的过渡帧）。
        """
        c = self.canvas
        geo = self._geo
        w, h = geo.width, geo.height
        c.delete("all")
        self.text.reset()
        self._bg = c.create_image(0, 0, anchor="nw")

        frame = self._collapsed_frame if self._collapsed else self._last_frame
        if frame is not None and frame.size == (w, h):
            try:
                self._img = ImageTk.PhotoImage(frame, master=c)
                c.itemconfigure(self._bg, image=self._img)
            except Exception:
                pass
        elif seed and self._last_frame is not None:
            preview = self._last_frame.resize((w, h), Image.Resampling.BILINEAR)
            try:
                self._img = ImageTk.PhotoImage(preview, master=c)
                c.itemconfigure(self._bg, image=self._img)
            except Exception:
                pass
        if PREVIEW:
            c.create_rectangle(0, 0, w, h, fill="#0d131d", outline="", tags=("preview-bg",))
            c.tag_lower("preview-bg")

        self._draw_header()
        if self._collapsed:
            self._bind_header()
            c.itemconfigure(self._bg, state="normal")
            self._bar_len = max(72, int(w * BAR_FRAC))
            self._bar = c.create_line(w // 2 - self._bar_len // 2, BAR_Y,
                                      w // 2 + self._bar_len // 2, BAR_Y,
                                      width=BAR_THICK, fill=self._bar_color,
                                      capstyle="round")
            self.text.refresh()
            return

        self._draw_feed()
        self._draw_input()
        self._draw_scrollbar()
        self._bind_header()
        c.tag_bind("send", "<Button-1>", self._send)
        c.tag_bind("inputzone", "<Button-1>", self._focus_input)
        c.tag_raise("close")
        c.tag_raise("send")

        self._bar_len = max(72, int(w * BAR_FRAC))
        self._bar = c.create_line(w // 2 - self._bar_len // 2, BAR_Y,
                                  w // 2 + self._bar_len // 2, BAR_Y,
                                  width=BAR_THICK, fill="#b8cbe0", capstyle="round")
        self._bar_color = "#b8cbe0"
        self.text.refresh()

    def _draw_header(self) -> None:
        c = self.canvas
        w = self._geo.width
        mic_on = self._mic_proc is not None and self._mic_proc.poll() is None
        dot = "#e05a5a" if mic_on else "#0a84ff"
        # 标题栏玻璃是 y=12..66，中心 39；右边 ▾/✕ 也在 38。点、名字、状态必须
        # 同一条水平中线，且字号要能完整落在条内，不能压到气泡区。
        cy, dot_x, title_x = 38, 54, 68
        c.create_oval(dot_x - 9, cy - 9, dot_x + 9, cy + 9,
                      outline="#2b4d73" if dot == "#0a84ff" else "#6b3030", width=1)
        c.create_oval(dot_x - 4, cy - 4, dot_x + 4, cy + 4, fill=dot, outline="")
        name = self.name[:10]
        self.text.draw(title_x, cy, name, anchor="w", fill="#f7fbff", size=16,
                       bold=True, tags=("title",))
        count = self.feed.status or f"{len(self.feed.messages)} 条"
        nx = title_x + self.fonts.get(16, True).measure(name) + 10
        self.text.draw(nx, cy, count, anchor="w",
                       fill="#ffb4b4" if self.feed.status else "#dbe6f5", size=11)
        self.text.draw(w - 94, 38, "▾", anchor="w", fill="#7f8da3", size=12, tags=("collapse",))
        self.text.draw(w - 58, 38, "✕", anchor="w", fill="#9fb0c8", size=13, tags=("close",))

    def _bind_header(self) -> None:
        c = self.canvas
        c.tag_bind("close", "<Button-1>", self._close)
        c.tag_bind("collapse", "<Button-1>", self.toggle_collapse)
        # 双击改名：单击要留给「按住标题拖动窗口」，两者不能抢同一个事件
        c.tag_bind("title", "<Double-Button-1>", self._edit_title)

    def _draw_feed(self) -> None:
        w = self._geo.width
        shown = self.feed.visible()
        if shown:
            shapes, infos = self._message_shapes(shown)
        else:
            shapes, infos = shapes_for(w, self._geo.height), []
        if shapes != self._geo.shapes:
            with self._geo_lock:
                self._set_geometry(self._geo.with_shapes(shapes, plate=bool(shown)))
        # 每条消息只按正文占一块；时间戳贴在气泡上方，不进框
        c = self.canvas
        for idx, info in enumerate(infos):
            if info["stamp"]:
                self.text.draw(info["tx"], info["stamp_y"], info["stamp"],
                               anchor=info["ta"], fill="#a8b7c9", size=9, tags=("feed",))
            for li, line in enumerate(info["lines"]):
                # 气泡里有底板，文字颜色固定、再补一层 1px 深色偏移当描边
                self.text.draw(info["tx"], info["ty"] + li * info["ls"], line,
                               anchor=info["ta"], fill="#edf6ff", size=11, tags=("feed",),
                               shadow=PLATE, adapt=not PLATE)
            if not (info["clipped"] or info["expanded"]):
                continue
            # 截断/展开的气泡给一块透明热区（fill="" 只占事件、不画像素）和一个
            # 角标：光靠省略号看不出是被砍了，更没有入口把剩下的读出来。
            bx0, by0, bx1, by1, _r = info["shape"]
            tag = f"bubble{idx}"
            c.create_rectangle(bx0, by0, bx1, by1, fill="", outline="",
                               tags=("feed", "bubblehit", tag))
            self.text.draw(bx1 - 12, by1 - 11, "▴" if info["expanded"] else "▾",
                           anchor="center", fill="#9fc7ff", size=9, tags=("feed", tag))
            c.tag_bind(tag, "<Button-1>",
                       lambda _e, k=info["key"]: self._toggle_expand(k))
        if not shown:
            slot = self._geo.shapes[0]
            self.text.draw(w // 2, slot[1] + (slot[3] - slot[1]) // 2,
                           "在这里跟它说话 · 滚轮翻历史", anchor="center",
                           fill="#8e9db2", size=12, tags=("feed",))

    def _draw_input(self) -> None:
        geo = self._geo
        x0, y0, x1, y1, _r = geo.input_shape
        self._ensure_entry()
        # Entry 放到 2x2 且底色是键色：真正显示的文字画在 Canvas 上，
        # 否则玻璃里会出现一个突兀的黑条（IME 候选框仍然正常）。
        self._entry_item = self.canvas.create_window(
            x0 + 84, y0 + 27, window=self._entry, anchor="w",
            width=2, height=2, tags=("feed",))
        self._render_input()
        sx0, sy0, sx1, sy1, _r = geo.send_shape
        self.text.draw((sx0 + sx1) // 2, sy0 + 27, "发送", tags=("send", "feed"),
                       fill="#ffffff", size=12, bold=True)

    def _draw_scrollbar(self) -> None:
        """滚动条放在主体玻璃右侧外面，不占消息区。"""
        c = self.canvas
        c.delete("sbar")
        total = len(self.feed.messages)
        visible = MESSAGE_SLOTS
        if total <= visible:
            return
        body = self._geo.slabs[1]
        x = self._geo.width - 6
        top = body[1] + 8
        view_h = max(1, body[3] - body[1] - 16)
        thumb = max(24, int(view_h * (visible / float(total))))
        max_off = max(1, total - visible)
        t = 1.0 - max(0, min(max_off, self.feed.offset)) / float(max_off)
        y0 = top + t * max(0, view_h - thumb)
        c.create_line(x, y0, x, y0 + thumb, width=3, fill="#8d95a4",
                      capstyle="round", tags=("sbar",))
        c.tag_raise("sbar")

    def _refresh_feed(self) -> None:
        """聊天流变了就重排；Entry 的草稿和焦点要保住（它在 _layout 里复用）。"""
        if not hasattr(self, "canvas"):
            return
        self._layout()
        if self._last_frame is not None:
            self._adapt_now(self._last_frame)

    def _adapt_now(self, frame) -> None:
        self._aux_at = 0.0
        self.text.adapt(frame)
        self._adapt_bar(frame)

    def _adapt_bar(self, frame) -> None:
        """最上面细条随背景切换深浅（同样要滞回，理由见 TextLayer.adapt）。"""
        if frame is None or self._bar is None:
            return
        now = time.time()
        if now - self._aux_at < 0.25:
            return
        self._aux_at = now
        mid = self._geo.width // 2
        half = max(50, self._bar_len // 2)
        try:
            arr = np.asarray(frame.convert("L"))
        except Exception:
            return
        patch = arr[max(0, BAR_Y - 6):BAR_Y + 12, max(0, mid - half):mid + half]
        if patch.size == 0:
            return
        p50 = float(np.median(patch)) / 255.0
        cur = self._bar_color
        if cur == "#4e6278":
            fill = "#b8cbe0" if p50 < 0.36 else cur      # 已很深：要够暗才翻浅
        else:
            fill = "#4e6278" if p50 > 0.60 else cur
        if fill != cur:
            self._bar_color = fill
            try:
                self.canvas.itemconfigure(self._bar, fill=fill)
            except Exception:
                pass

    # ---- 预览 / 重建 ----

    def _preview_resize(self, w: int, h: int) -> None:
        """拖拽时先缩放上一帧并重排文字，松手后再重建玻璃贴图。

        这一路故意**不**重建遮罩/折射图：拖拽期间 worker 是停的，只要文字和
        上一帧跟得上手就行；松手的 `_rebuild()` 才做完整重建。
        """
        if w < MIN_W or h < MIN_H:
            return
        with self._geo_lock:
            self._geo = Geometry.for_size(w, h, version=self._geo.version)
            self._renderer.geo = self._geo
        self.canvas.config(width=w, height=h)
        if self._last_frame is not None and self._last_frame.size != (w, h):
            self._last_frame = self._last_frame.resize((w, h), Image.Resampling.BILINEAR)
        self._layout()

    def _rebuild(self, w: int, h: int) -> None:
        """松手后按最终尺寸重建（含遮罩/折射图）。"""
        self._pause.set()
        with self._geo_lock:
            self._set_geometry(Geometry.for_size(w, h))
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                break
        self._layout(seed=True)
        self._pause.clear()

    # ---- 截屏 / 心跳 ----

    def _snapshot_mode(self) -> None:
        """只给文档截图：停抓取、关 WDA，保留最后一帧（不改变正常路径）。"""
        self._snapshot_done = True
        self._pause.set()
        if self._excluded:
            self._set_exclude(False)

    def _beat(self) -> None:
        """写心跳（每秒最多一次）。插件侧 `windowAlive()` 读它的 mtime。"""
        now = time.time()
        if now - getattr(self, "_beat_at", 0.0) < HEARTBEAT_EVERY:
            return
        self._beat_at = now
        try:
            HEARTBEAT.parent.mkdir(parents=True, exist_ok=True)
            HEARTBEAT.write_bytes(b"")
        except Exception:
            pass

    # ---- 主循环 ----

    def _tick(self) -> None:
        self._beat()
        if SNAPSHOT and self._snapshot_done:
            self._pause.set()
            if self._excluded:
                self._set_exclude(False)
            self.root.after(100, self._tick)
            return
        if PREVIEW:
            self._pause.set()
            if self._excluded:
                self._set_exclude(False)
            self.root.after(100, self._tick)
            return
        # 缩放拖拽期间由 _preview_resize 负责画面，避免旧帧覆盖预览
        if self._resize or self._collapsed:
            self.root.after(INTERVAL_MS, self._tick)
            return
        if not self._excluded and not self._cappable and not self._solid:
            self._set_exclude(True)
        self._pause.clear()

        try:
            out = self._q.get_nowait()
        except queue.Empty:
            out = None
        delay = INTERVAL_MS
        if out is not None:
            t_draw = time.perf_counter()
            try:
                self._last_frame = out
                self._img = ImageTk.PhotoImage(out, master=self.canvas)
                self.canvas.itemconfigure(self._bg, image=self._img)
                self.canvas.tag_lower(self._bg)
                self.text.adapt(out)
                self._adapt_bar(out)
            except Exception as exc:
                print("draw error", exc, flush=True)
            cost_ms = (time.perf_counter() - t_draw) * 1000.0
            self._draw_ms = self._draw_ms * 0.8 + cost_ms * 0.2
            # 主线程绘制本身超过一帧预算时，别按固定 16ms 硬塞下一帧：
            # 给 Tk 留出处理鼠标/键盘的时间，否则事件队列越积越长，手感就是卡。
            delay = max(INTERVAL_MS, min(100, int(self._draw_ms * 1.5)))

        self.root.after(delay, self._tick)

    def _work(self) -> None:
        """抓取 + 合成全在后台，主线程只负责显示最新一帧。"""
        import mss

        idle = 0
        with mss.mss() as sct:
            while not self._stop.is_set():
                if self._pause.is_set() or self._collapsed:
                    time.sleep(0.03)
                    continue
                t0 = time.perf_counter()
                try:
                    out = self._renderer.render(self._source, sct, self._bbox())
                    if out is not None:
                        idle = 0
                        try:
                            self._q.get_nowait()
                        except queue.Empty:
                            pass
                        self._q.put(out)
                    else:
                        idle += 1
                except Exception as exc:
                    print("capture error", exc, flush=True)
                    # GPU 起不来（没有 moderngl / 显卡不支持 GL3.3）就换回 CPU，
                    # 不然后台线程每帧刷一条，用户只看到一块永远不刷新的玻璃。
                    if getattr(self._renderer, "broken", False):
                        print("GPU 不可用，切换到 CPU 渲染", flush=True)
                        self._renderer = CpuRenderer(self._geo)
                dt = time.perf_counter() - t0
                self._ema = self._ema * 0.9 + dt * 0.1
                if self._ema > 0.026:
                    target = 45
                elif self._ema > 0.016:
                    target = 60
                elif self._ema > 0.011:
                    target = 90
                else:
                    target = MAX_FPS
                # 自适应只能往下走；不能越过启动时的上限（默认 60），
                # 否则 120fps 的旧阈值会把已经设成 60 的窗口又抬回 90fps。
                self._target_fps = max(30, min(target, MAX_FPS, self._hz))
                # 静态画面：合成已经跳过，但「有没有变」只能靠抓屏看，单次 grab
                # 就要 ~7ms —— 按 60fps 空转等于白烧 40% 单核。探针降到 30fps，
                # 有变化时 idle 立刻归零、下一拍就恢复全速（最坏多等 33ms，
                # 拖动/滚动/播视频这类真的在动的情况根本进不到这个分支）。
                fps = self._target_fps if idle <= 20 else min(self._target_fps, PROBE_FPS)
                time.sleep(max(0.004, 1 / max(1, fps) - dt))

    # ---- 窗口句柄 ----

    def _hwnd_root(self):
        if self._hwnd is None:
            self._hwnd = ctypes.windll.user32.GetAncestor(self.root.winfo_id(), 2)
        return self._hwnd

    def _set_exclude(self, on: bool) -> None:
        hwnd = self._hwnd_root()
        fn = ctypes.windll.user32.SetWindowDisplayAffinity
        fn.argtypes = [wintypes.HWND, wintypes.DWORD]
        fn.restype = wintypes.BOOL
        ok = bool(fn(hwnd, 0x11 if on else 0))
        self._excluded = ok and on
        if not ok:
            print("WDA failed", ctypes.GetLastError(), flush=True)

    def _bbox(self):
        rc = _RECT()
        ctypes.windll.user32.GetWindowRect(self._hwnd_root(), ctypes.byref(rc))
        return (rc.left, rc.top, rc.right, rc.bottom)

    def _sync_pos(self) -> None:
        """把 Tk 当前左上角同步回 _x/_y。

        拖动/缩放只改了 root.geometry，没改这两个缓存；折叠时如果继续用旧坐标，
        窗口会被拉回拖动前的位置（用户看到的就是「点收起位置跳回」）。
        """
        try:
            self._x = int(self.root.winfo_x())
            self._y = int(self.root.winfo_y())
        except Exception:
            pass

    def _save_geometry(self) -> None:
        h = self._saved_h if self._collapsed else self.root.winfo_height()
        write_config({"geometry": f"{self.root.winfo_width()}x{h}"
                                  f"+{self.root.winfo_x()}+{self.root.winfo_y()}"})

    # ---- 关闭 / 隐藏 ----

    def _close(self, _e=None):
        try:
            self._save_geometry()
            self._stop_mic()
            self._stop.set()
            self._pause.set()
            self._set_exclude(False)
            self._worker.join(timeout=0.3)
            try:
                self._renderer.close()
            except Exception:
                pass
            ctypes.windll.winmm.timeEndPeriod(1)
        finally:
            self.root.destroy()
        return "break"

    # ---- 边缘缩放 / 拖动 ----

    def _edge_at(self, x, y):
        w, h = self.root.winfo_width(), self.root.winfo_height()
        # 圆角是透明的，鼠标落在最外侧时命中的是 DWM 非客户区；
        # 命中带放宽到 20px，用户不必精确到 1px 也能拖边缘/四角。
        edge, corner = 20, 32
        if x <= corner and y <= corner:
            return "nw"
        if x >= w - corner and y <= corner:
            return "ne"
        if x <= corner and y >= h - corner:
            return "sw"
        if x >= w - corner and y >= h - corner:
            return "se"
        if y <= edge:
            return None          # 顶部中间只拖动，不缩放
        if x <= edge:
            return "w"
        if x >= w - edge:
            return "e"
        if y >= h - edge:
            return "s"
        return None

    @staticmethod
    def _cursor_for(mode):
        return {"nw": "size_nw_se", "se": "size_nw_se",
                "ne": "size_ne_sw", "sw": "size_ne_sw",
                "w": "size_we", "e": "size_we",
                "n": "size_ns", "s": "size_ns"}.get(mode, "")

    def _hover(self, e):
        if self._resize:
            return
        try:
            self.canvas.config(cursor=self._cursor_for(self._edge_at(e.x, e.y)))
        except Exception:
            pass

    def _leave(self, _e):
        if not self._resize:
            self.canvas.config(cursor="")

    def _press(self, e):
        # 每次按下先把屏幕布局重新读一遍：拖动前插/拔显示器也能立刻生效
        self._sync_screens()
        # 麦克风图标画在玻璃里，不在 Canvas 上单独建控件；点它不能当拖窗
        mx, my = self._geo.mic_pos
        if abs(e.x - (mx + MIC_SIZE // 2)) <= 22 and abs(e.y - (my + MIC_SIZE // 2)) <= 22:
            self._toggle_mic()
            return
        x0, y0, x1, y1, _r = self._geo.input_shape
        if x0 <= e.x <= x1 and y0 <= e.y <= y1:
            self._focus_input()
            return
        mode = self._edge_at(e.x, e.y)
        if mode:
            self._resize = (mode, e.x_root, e.y_root,
                            self.root.winfo_x(), self.root.winfo_y(),
                            self.root.winfo_width(), self.root.winfo_height())
            self._drag = None
            self._pause.set()
            return
        self._drag = (e.x_root - self.root.winfo_x(),
                      e.y_root - self.root.winfo_y())

    def _motion(self, e):
        if self._resize:
            mode, sx, sy, x0, y0, w0, h0 = self._resize
            dx, dy = e.x_root - sx, e.y_root - sy
            nw, nh, nx, ny = w0, h0, x0, y0
            # 缩放边界 = 虚拟桌面（多显示器），不是主屏
            vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
            if "e" in mode:
                nw = max(MIN_W, min(max(MIN_W, vx + vw - x0), w0 + dx))
            if "w" in mode:
                nw = max(MIN_W, min(max(MIN_W, x0 + w0 - vx), w0 - dx))
                nx = x0 + w0 - nw
            if "s" in mode:
                nh = max(MIN_H, min(max(MIN_H, vy + vh - y0), h0 + dy))
            if "n" in mode:
                nh = max(MIN_H, min(max(MIN_H, y0 + h0 - vy), h0 - dy))
                ny = y0 + h0 - nh
            nx = max(vx, min(nx, max(vx, vx + vw - nw)))
            ny = max(vy, min(ny, max(vy, vy + vh - nh)))
            self.root.geometry(f"{nw}x{nh}+{nx}+{ny}")
            now = time.time()
            if now - self._preview_at >= 0.04:
                self._preview_at = now
                self._preview_resize(nw, nh)
            return
        if self._drag:
            # 拖到屏幕外时窗口坐标会变负，抓屏区域随之越界（高度算出负数），
            # 背景永远画不出来 —— 表现为花屏。必须钳位。
            # 边界是虚拟桌面而不是主屏：第二块屏在主屏左边时坐标本来就是负的，
            # 老代码 max(0, …) 等于把窗口钉死在一块屏里。
            vx, vy, vw, vh = self._vx, self._vy, self._vw, self._vh
            nx = e.x_root - self._drag[0]
            ny = e.y_root - self._drag[1]
            nx = max(vx, min(nx, max(vx, vx + vw - self.root.winfo_width())))
            ny = max(vy, min(ny, max(vy, vy + vh - self.root.winfo_height())))
            self.root.geometry(f"+{nx}+{ny}")

    def _release(self, e):
        if self._resize:
            self._resize = None
            self._preview_at = 0.0
            self.root.update_idletasks()
            self._rebuild(max(MIN_W, self.root.winfo_width()),
                          max(MIN_H, self.root.winfo_height()))
            self._sync_pos()
            self._hover(e)
            return
        self._drag = None
        self._sync_pos()

    def run(self):
        self.root.bind("<Escape>", self._close)
        self.root.bind("<MouseWheel>", self._wheel)
        self.root.bind("<Motion>", self._hover, add="+")
        self.root.bind("<Leave>", self._leave, add="+")
        self.root.bind("<ButtonPress-1>", self._press, add="+")
        self.root.bind("<B1-Motion>", self._motion, add="+")
        self.root.bind("<ButtonRelease-1>", self._release, add="+")
        self.root.mainloop()


if __name__ == "__main__":
    LiveGlass().run()
