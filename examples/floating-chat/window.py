#!/usr/bin/env python3
# ⚠️ 本文件由 dsh-see-now/scripts/sync-window.mjs 生成，请勿手改（要改请改上游 dsh-watch-together）
"""陪看悬浮窗：不铺全屏背景图，实时抓窗口背后的桌面并模糊成液态玻璃。

四层，各自不知道对方的实现：

    glass_geometry.py   一套尺寸的全部贴图（不可变，尺寸/形状变了换一个新对象）
    glass_cpu.py        CPU 合成：抓屏 → 模糊 → 边缘折射 → 内框透镜 → 染色 → 色散
    glass_gpu.py        同一件事搬到 GPU（moderngl / OpenGL 3.3+）
    glass_static.py     不吃性能的底板：预生成一张磨砂/纯色，换尺寸才重画
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

样式预设（`~/.dsh/watch-window.json` 的 `glass`，设置页里可改，改完热切换）：

    live    实时玻璃：抓屏 + 模糊，跟着桌面走。最好看，也最吃 CPU。
    frost   静态磨砂：一张预生成的底板，不抓屏、不逐帧合成 —— 不吃性能。
    solid   纯色底板：远程桌面/录屏兜底，任何捕获方式都看得见。
    auto    不写或写 auto：远程/录屏环境自动用 solid，其余用 live。

渲染后端：默认 CPU。`DSH_GLASS_NATIVE=1` 或 `DSH_GLASS_GPU=1` 走 GPU（只对 live 有效）。
"""
# `X | Y` 形式的注解要这个才在 3.9 上不求值（见 #45：Xcode CLT 自带 3.9 是 mac 上
# 最好拿的一个解释器，不该因为注解写法把它排除掉）。
from __future__ import annotations

import ctypes
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

# 是不是 Windows。**所有 ctypes.windll / wintypes / WDA 都必须先问它**：
# `ctypes.windll` 在 macOS/Linux 上根本不存在，模块顶层摸一下就是
# `AttributeError: module 'ctypes' has no attribute 'windll'`，而且死在依赖预检
# 之前，用户看到的是"启动后 700ms 退出，code=1"（issue #40）。
IS_WIN = os.name == "nt"

# 窗口扩展样式：`noActivate` 用它（点窗不激活，见 `_apply_no_activate`）
GWL_EXSTYLE = -20
WS_EX_NOACTIVATE = 0x08000000

if IS_WIN:
    from ctypes import wintypes

# 必须在 import tkinter / 创建任何窗口之前声明 per-monitor v2 DPI 感知。
if IS_WIN:
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
    # 弹窗标题跟着"谁拉起的这个窗"走：see-now 的用户看到 dsh-watch-together 会以为装错了包
    try:
        ctypes.windll.user32.MessageBoxW(None, text,
                                         os.environ.get("DSH_WINDOW_BRAND") or "dsh-watch-together", 0x10)
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

# 样式预设。`auto` 只出现在配置里（表示"看环境自动选"），解析后只会是下面三个之一。
STYLE_LIVE, STYLE_FROST, STYLE_SOLID = "live", "frost", "solid"
GLASS_STYLES = (STYLE_LIVE, STYLE_FROST, STYLE_SOLID)
# 静态样式：不抓屏、不起渲染线程，只在换尺寸/换形状时重画一张底板。
STATIC_STYLES = (STYLE_FROST, STYLE_SOLID)

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


def write_config(patch: dict, drop=()) -> None:
    """合并写。`drop` 里的键会被删掉（`mode: full` 不落盘，见 `_write_mode`）。"""
    cfg = read_config()
    cfg.update(patch or {})
    for key in drop:
        cfg.pop(key, None)
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
    if not IS_WIN:
        return False
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


def glass_style(cfg: dict | None = None) -> str:
    """样式预设：live（实时玻璃）/ frost（静态磨砂）/ solid（纯色）。

    `WDA_EXCLUDEFROMCAPTURE` 会让窗口在远程桌面、OBS、截图工具里**整窗消失**
    （微软文档：“Everywhere else, the window does not appear at all”）。
    本机看起来正常，因为 mss 抓到的是窗口背后的像素；远程端却连文字都看不到。
    所以选了 live 也要在远程环境下兜底成 solid —— 好看不能压过"看得见"。

    性能反过来是另一头：live 每帧都要抓屏 + 模糊，低配机/高分屏上会明显掉帧。
    frost 和 solid 都不碰屏幕，只在换尺寸时画一张（见 `glass_static.py`）。

    读 `~/.dsh/watch-window.json` 的 `glass`；不写 / `auto` = 按环境自动选。
    环境变量优先级更高，只对这一次启动有效（插件拉起窗口时不传环境变量）。
    """
    if os.environ.get("DSH_GLASS_SOLID") == "1":
        return STYLE_SOLID
    if os.environ.get("DSH_GLASS_FROST") == "1":
        return STYLE_FROST
    if os.environ.get("DSH_GLASS_LIVE") == "1":
        return STYLE_LIVE
    if cfg is None:
        try:
            cfg = read_config()
        except Exception:
            cfg = {}
    try:
        mode = str((cfg or {}).get("glass") or "").strip().lower()
    except Exception:
        mode = ""
    if mode == STYLE_FROST:
        return STYLE_FROST
    if mode == STYLE_SOLID:
        return STYLE_SOLID
    if mode == STYLE_LIVE:
        return STYLE_SOLID if remote_capture_likely() else STYLE_LIVE
    # 空值 / auto：RDP 标志位或常见远程软件窗口任一命中，就用 solid。
    return STYLE_SOLID if remote_capture_likely() else STYLE_LIVE


def no_activate_wanted(cfg: dict | None = None) -> bool:
    """`~/.dsh/watch-window.json` 的 `noActivate`：点窗不激活它（默认关）。

    **为什么要它**：悬浮窗是 topmost，鼠标点一下会把它激活，Windows 随之重排
    topmost 带 —— 用户开着全屏游戏时，宿主窗跟着被顶上来、游戏被切走（#44 第 1 条）。

    **为什么默认关**：`WS_EX_NOACTIVATE` 的窗口拿不到键盘焦点，输入框直接打不了字。
    打开之后点输入区会先摘掉这条样式（见 `_focus_input`），但那条路没法自动化验证，
    所以让用户自己选，而不是替他决定。

    环境变量 `DSH_WINDOW_NO_ACTIVATE=1` 优先级更高（只对这一次启动有效）。
    """
    if os.environ.get("DSH_WINDOW_NO_ACTIVATE") == "1":
        return True
    if cfg is None:
        try:
            cfg = read_config()
        except Exception:
            cfg = {}
    try:
        return bool((cfg or {}).get("noActivate"))
    except Exception:
        return False


# ---------------------------------------------------------------- 模式与弹幕
#
# 两档模式（互斥）+ 一个正交的弹幕开关：
#
#   full     完整玻璃窗（折叠成 78 高横条是 UI 内的临时态，不落盘）
#   hidden   最小化：真的从屏幕上消失，只在托盘留一个图标
#
# 弹幕是独立窗口（`danmaku.py`），和模式正交：`hidden + 弹幕` 就是
# "打游戏不挡视野、又能瞥一眼消息"的那一档。

MODE_FULL, MODE_HIDDEN = "full", "hidden"
WINDOW_MODES = (MODE_FULL, MODE_HIDDEN)
DANMAKU_EDGES = ("top", "bottom")

# 最小化后的**第二**恢复通道：Windows 11 会把新托盘图标塞进溢出区（要点 ∧ 才看得见），
# 只靠图标用户可能根本找不到窗口。热键用 GetAsyncKeyState 轮询 —— 不能用
# RegisterHotKey：那要独占一个消息循环，和 Tk 的抢。
VK_CTRL, VK_ALT, VK_W = 0x11, 0x12, 0x57
HOTKEY_GAP = 1.2          # 秒，长按不重复触发


def window_mode(cfg=None) -> str:
    """配置要哪一档。

    `mode` 是新的唯一真相源；但**老的 `hidden` 布尔键必须继续生效** ——
    磁盘上的配置是两个人写的（插件和自己），只认新键会让"点了藏起来"的老用户
    升级后窗口又冒出来。
    """
    if cfg is None:
        cfg = read_config()
    cfg = cfg or {}
    mode = str(cfg.get("mode") or "").strip().lower()
    if mode in WINDOW_MODES:
        return mode
    return MODE_HIDDEN if cfg.get("hidden") is True else MODE_FULL


def danmaku_wanted(cfg=None) -> bool:
    """默认关：替用户决定"打游戏时飘字"是不礼貌的。"""
    if cfg is None:
        cfg = read_config()
    return (cfg or {}).get("danmaku") is True


def danmaku_options(cfg=None) -> dict:
    """弹幕的几何 + 外观。六个键都能在 `watch-window.json` 里手改。

    外观三项（2026-11 加）：13px 在 2560×1440 上偏小（用户实报），字号/字色/描边
    现在可配；非法值由 `danmaku.py` 那边退回默认，这里只做原样透传。
    """
    if cfg is None:
        cfg = read_config()
    cfg = cfg or {}
    try:
        speed = int(cfg.get("danmakuSpeed") or 220)
    except (TypeError, ValueError):
        speed = 220
    try:
        lanes = int(cfg.get("danmakuLanes") or 2)
    except (TypeError, ValueError):
        lanes = 2
    edge = str(cfg.get("danmakuEdge") or "top").strip().lower()
    try:
        font_size = int(cfg.get("danmakuFontSize"))
    except (TypeError, ValueError):
        font_size = None
    return {"edge": edge if edge in DANMAKU_EDGES else "top",
            "lanes": max(1, min(3, lanes)),
            "speed": max(40, min(400, speed)),
            "font_family": str(cfg.get("danmakuFont") or "").strip() or None,
            "font_size": font_size,
            "fg": str(cfg.get("danmakuFg") or "").strip() or None,
            "shadow": str(cfg.get("danmakuShadow") or "").strip() or None}


def append_user(text: str) -> None:
    CHAT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CHAT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps({"role": "user", "text": text, "at": int(time.time() * 1000)},
                           ensure_ascii=False) + "\n")


def asr_python() -> str:
    """麦克风用哪个 Python。

    **优先用跑窗口的这个解释器**（`sys.executable`）。两个理由，都是踩出来的：

    1. 它是 `pythonw.exe` —— 用 PATH 上的 `python.exe` 起 `mic.py` 会**弹一个黑框**
       （用户报的"启动 asr 老是弹命令行窗口"）；
    2. `pyaudiowpatch` 只装在用户那个 asr venv 里。回退到 PATH 上的 python，
       `import pyaudiowpatch` 当场失败，而 stderr 是 DEVNULL，于是表现成
       "点了麦克风，什么都没发生"。

    显式配了 `DSH_ASR_PYTHON` / `DSH_FLOAT_PYTHON` 的仍然优先（给特殊环境留口子）。
    """
    for key in ("DSH_ASR_PYTHON", "DSH_FLOAT_PYTHON"):
        v = os.environ.get(key)
        if v:
            return v
    exe = sys.executable or ""
    # 万一窗口就是用 python.exe 起的：换成同目录的 pythonw.exe，别开控制台
    if os.name == "nt" and exe.lower().endswith("python.exe"):
        guess = exe[:-len("python.exe")] + "pythonw.exe"
        if os.path.exists(guess):
            exe = guess
    if exe and os.path.exists(exe):
        return exe
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
        # **崩溃取证**：`pythonw` 没有 stderr，段错误时用户只看到"窗口没了"。
        # faulthandler 会在信号里把**所有线程**的 Python 栈写进这个文件 ——
        # 没有它，ctypes 回调踩内存这种问题只能靠猜（本机实测过两次 Segfault）。
        self._fault_log = None
        if os.environ.get("DSH_WINDOW_FAULTLOG", "1") != "0":
            try:
                import faulthandler
                log_path = cache_dir() / "window-fault.log"
                log_path.parent.mkdir(parents=True, exist_ok=True)
                self._fault_log = open(log_path, "a", encoding="utf-8", buffering=1)
                self._fault_log.write(
                    "\n=== start pid=%d %s ===\n" % (os.getpid(), time.strftime("%Y-%m-%d %H:%M:%S")))
                faulthandler.enable(file=self._fault_log, all_threads=True)
            except Exception:
                self._fault_log = None
        raw_name = cfg.get("name")
        self.name = (raw_name.strip()[:24] if isinstance(raw_name, str) and raw_name.strip()
                     else "陪看")

        self.feed = ChatFeed(CHAT_FILE)
        self._mic_proc = None
        self._protocol = WindowProtocol() if WindowProtocol is not None else None
        self._collapsed = False
        self._saved_h = DEFAULT_H
        self._mode = window_mode(cfg)
        self._tray = None
        self._tray_hinted = False
        self._hotkey_at = 0.0
        self._toast = ""
        self._danmaku = None
        # 未读角标：只看"比上次展开时更新的"消息。首次启动没有这个键时按现在算，
        # 否则历史 80 条会全算未读。
        self._last_read_at = int(cfg.get("lastReadAt") or time.time() * 1000)
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
        # `-transparentcolor` 是 Tk 的 **Windows 专有** 属性：aqua 的合法集合是
        # `-alpha / -fullscreen / -modified / -notify / -titlepath / -topmost / -transparent`，
        # X11 也没有它。无条件调用 → `TclError: bad attribute "-transparentcolor"`，
        # 死在 `__init__` 里，用户看到的是"窗口起不来"（#45 macOS、PR #38 Linux 都栽在这行）。
        # 非 Windows 上就留着 KEY 这个底色（窗口退化成一张深色卡片），别再让整个窗口起不来。
        if IS_WIN:
            self.root.attributes("-transparentcolor", KEY)
        self.fonts = Fonts(self.root)

        self._sw, self._sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        # 主屏尺寸只用来算默认位置；能拖到哪、抓屏能抓到哪，看虚拟桌面（多显示器）
        self._vx, self._vy, self._vw, self._vh = virtual_bounds(self._sw, self._sh)
        w, h, x, y = self._initial_geometry(cfg.get("geometry"))
        self._saved_h = h
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
        # **非 Windows 一律按"能抓到自己"处理**：那边没有 WDA，不挖就是"透过自己看自己"。
        self._cappable = capturable() or not IS_WIN
        # 样式：live / frost / solid。静态样式不抓屏、不设 WDA、不起渲染线程。
        self._style = glass_style(cfg)
        self._static = self._style in STATIC_STYLES
        self._solid = self._style == STYLE_SOLID
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
        # 抓屏源和渲染线程都是「换成 live 才有」的东西：静态样式下两条都不存在，
        # 所以不在这里建，交给 `_start_worker()`（换样式时会再调用一次）。
        self._source = None
        self._renderer = self._make_renderer(self._geo)
        self._worker = None
        self._worker_stop = None

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
        self._set_exclude(not capturable() and not self._static)
        # 点窗不激活（可选，见 `no_activate_wanted`）。必须等窗口真的映射出来再设扩展样式，
        # 否则 Tk 自己那次 `overrideredirect` 会把样式重写回去。
        self._no_activate = no_activate_wanted(cfg)
        self._no_activate_on = False
        if self._no_activate:
            self.root.after(0, lambda: self._apply_no_activate(True))
        self._start_worker()
        # 托盘：只在最小化时出现。这是"缩到底下"之后唯一能点回来的地方。
        # `DSH_TRAY=0` 关掉它（只剩 Ctrl+Alt+W 和宿主工具）—— 二分排查段错误用：
        # 托盘是这里唯一碰 ctypes 回调的东西，崩和不崩只差这一个开关。
        if os.environ.get("DSH_TRAY", "1") != "0":
            try:
                from tray import TrayIcon
                self._tray = TrayIcon(self.root, tip=f"{self.name} · 点击展开",
                                      icon_png=str(HERE / "mic-dsh.png"),
                                      cache_dir=cache_dir(),
                                      # **必须带 save=True**：只把窗口放回来而不改配置，
                                      # 250ms 后 `_sync_config` 读到还是 `mode: hidden`，
                                      # 立刻又把它收回去（实测：点了托盘窗口闪一下就没了）。
                                      on_activate=lambda: self._apply_mode(MODE_FULL, save=True))
            except Exception as exc:
                self._tray = None
                print("tray unavailable", repr(exc), flush=True)
        self.root.lift()
        self.root.after(80, self.root.lift)
        self.root.after(120, self.root.focus_set)
        self.root.after(60, self._tick)
        self.root.after(30, lambda: self._intro_step(0))
        self.root.after(250, self._poll_chat)
        self.root.after(1200, self._keep_on_top)
        # 启动即按配置挂弹幕：`mode=hidden` / `mini` 走的是 __init__ 里的直接赋值，
        # 不经过 `_apply_mode()`，所以不能指望那条路把它带起来。
        self._sync_danmaku(cfg)
        if self._mode == MODE_HIDDEN:
            self._minimize()
        if SNAPSHOT:
            self.root.after(2600, self._snapshot_mode)

    # ---- 渲染后端 ----

    def _make_renderer(self, geo: Geometry):
        """按样式给一个渲染器：静态样式完全不碰屏幕。"""
        if self._static:
            from glass_static import StaticRenderer
            return StaticRenderer(geo, self._style)
        if USE_GPU:
            try:
                from glass_gpu import GpuRenderer
                return GpuRenderer(geo, MotionTracker(), native=NATIVE)
            except Exception as exc:
                print("GPU 初始化失败，回落到 CPU:", repr(exc), flush=True)
        return CpuRenderer(geo)

    def _start_worker(self) -> None:
        """起抓屏/合成线程。静态样式没有东西要算，直接不起。"""
        if self._static or self._worker is not None or self._stop.is_set():
            return
        self._source = CaptureSource((self._sw, self._sh), cappable=self._cappable,
                                     solid=self._solid,
                                     # 窗口落在副屏时，抓屏范围要按虚拟桌面钳
                                     bounds=(self._vx, self._vy, self._vw, self._vh))
        self._worker_stop = threading.Event()
        self._worker = threading.Thread(target=self._work, args=(self._worker_stop,),
                                        daemon=True)
        self._worker.start()

    def _stop_worker(self) -> None:
        """停线程。先摘掉引用再 join：`_work` 里还会读 `self._source`。"""
        worker, stop = self._worker, self._worker_stop
        self._worker, self._worker_stop = None, None
        if stop is not None:
            stop.set()
        if worker is not None:
            worker.join(timeout=0.4)

    def _apply_style(self, style: str) -> None:
        """换样式（配置文件一变就调用，不用重开窗口）。

        从 live 切走要真把抓屏线程停掉 —— 只换渲染器而不停线程，等于"静态样式"
        还在后台每帧抓屏，用户切过去还是卡，只是看不见画面在变。
        """
        if style not in GLASS_STYLES:
            style = STYLE_LIVE
        if style == self._style:
            return
        self._style = style
        self._static = style in STATIC_STYLES
        self._solid = style == STYLE_SOLID
        self._pause.set()
        self._stop_worker()
        try:
            self._renderer.close()
        except Exception:
            pass
        self._renderer = self._make_renderer(self._geo)
        if self._static:
            # 不再抓屏：WDA 没有意义，开着反而会让窗口在截图里消失
            self._set_exclude(False)
            self._last_frame = None
            if self._collapsed:
                # 折叠态贴的是 `_collapsed_frame`（不是 `_last_frame`）—— 清掉就是一块空白。
                # 按折叠尺寸直接画一张：`slabs_for()` 在折叠高度下只返回标题栏那一块。
                try:
                    self._collapsed_frame = self._renderer.frame_for(self._geo)
                except Exception:
                    self._collapsed_frame = None
            else:
                self._collapsed_frame = None
        else:
            self._start_worker()
        self._pause.clear()
        self._layout(seed=True)

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
            elif action in WINDOW_MODES:
                self._apply_mode(action, save=True)
            elif action == "danmaku":
                write_config({"danmaku": bool(value)})
                self._sync_danmaku()
            elif action == "hide":
                self._apply_mode(MODE_HIDDEN, save=True)
            elif action == "show":
                self._apply_mode(MODE_FULL, save=True)
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
            self._sync_config()
            if self._hidden and self._hotkey_down():
                now = time.time()
                if now - self._hotkey_at > HOTKEY_GAP:
                    self._hotkey_at = now
                    self._apply_mode(MODE_FULL, save=True)
            for event in self._drain_protocol():
                self._render_event(event)
            if self._mic_proc is not None and self._mic_proc.poll() is not None:
                self._mic_proc = None
                self.feed.status = ""
                self._refresh_feed()
            if self.feed.poll():
                self._collapse_expanded()
                self._refresh_feed()
                self._push_danmaku()
                self._sync_tray_tip()
        except Exception as exc:
            print("chat poll error", exc, flush=True)
        if not self._stop.is_set():
            self.root.after(250, self._poll_chat)

    def _sync_config(self) -> None:
        """配置文件变了：样式、模式、弹幕都跟着改（不用重开窗口）。

        设置页写的是同一个文件，读一次盘把三个键全处理掉 —— 用户点一下下拉，
        250ms 内窗口就换过来。顺序有讲究：先换样式（会重建渲染器），再切模式
        （会改尺寸并重排），最后挂弹幕（放最后，少一次无谓的窗口创建）。
        """
        try:
            st = CONFIG.stat()
            key = (st.st_mtime_ns, st.st_size)
        except OSError:
            key = None
        if key == self._cfg_key:
            return
        self._cfg_key = key
        cfg = read_config()
        self._apply_style(glass_style(cfg))
        self._apply_mode(window_mode(cfg), cfg=cfg)

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
            # 连滚只重排最后一次：滚十格就白画九遍（#44 第 2 条，社区实测每格卡 ~1 秒）
            self._schedule_feed_refresh()

    def _schedule_feed_refresh(self, delay: int = 40) -> None:
        job = getattr(self, "_feed_job", None)
        if job is not None:
            try:
                self.root.after_cancel(job)
            except Exception:
                pass
        self._feed_job = self.root.after(delay, self._run_feed_refresh)

    def _run_feed_refresh(self) -> None:
        self._feed_job = None
        self._relayout_feed()

    def _relayout_feed(self) -> None:
        """**只**重画聊天流那两层（滚轮走这条，不走整窗 `_layout()`）。

        `_layout()` 是 `delete("all")` + 标题栏 / 输入框 / 滚动条 / 事件绑定全部重来
        一遍；滚动时这些一个都没变，只有气泡和滚动条位置要跟着 `feed.offset` 走。
        把整窗重排放在滚轮上，就是社区报的"每滚一格卡将近一秒"（#44 第 2 条）。

        两个必须跟着做的：
        - `_draw_feed()` 可能因为折行数变了而换 `_geo`（气泡宽度跟着文字走），
          这时静态底板得重画一张，否则文字换了位置、底板还是上一套；
        - 删了 item 就必须 `text.reset()`：`_fixed` / `_colors` 存的是 item id，
          留着旧的会让新画出来的文字被当成"要跟背景翻色"，有底板的气泡会闪。
        """
        c = self.canvas
        shapes_before = self._geo.shapes
        # 删的是 `feedbody`，不是 `feed`：`_draw_input()` 里的「发送」两个字也挂着
        # `feed` tag（历史遗留），删 `feed` 会把按钮文字一起删掉，而 `_draw_feed()`
        # 不负责重画它 —— 滚一下滚轮发送键就变空白。
        c.delete("feedbody")
        c.delete("sbar")
        self.text.reset()
        self._draw_feed()
        self._draw_scrollbar()
        self.text.refresh()
        if self._geo.shapes != shapes_before:
            self._sync_static_frame()

    def _toggle_mic(self):
        if self._mic_proc is not None and self._mic_proc.poll() is None:
            self._stop_mic()
            return
        if not MIC_SCRIPT.exists():
            self.feed.status = "找不到 mic.py"
            self._refresh_feed()
            return
        try:
            # `CREATE_NO_WINDOW` 对商店版 python 的 app alias 不一定管用，
            # 再叠一层 STARTUPINFO + SW_HIDE：两样都上才真的不弹黑框。
            si = None
            flags = 0
            if os.name == "nt":
                si = subprocess.STARTUPINFO()
                si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                si.wShowWindow = subprocess.SW_HIDE
                flags = 0x08000000          # CREATE_NO_WINDOW
            self._mic_proc = subprocess.Popen(
                [asr_python(), str(MIC_SCRIPT), "--engine", "local"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=flags, startupinfo=si,
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
        # noActivate 开着时先摘掉那条样式，否则 focus_force 也拿不到键盘焦点
        # （WS_EX_NOACTIVATE 的窗口本来就不接受焦点）。摘掉后本次运行不再加回，
        # 理由见 `_apply_no_activate`。
        if getattr(self, "_no_activate_on", False):
            self._apply_no_activate(False)
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

    def _set_collapsed(self, on: bool) -> None:
        """折叠 / 展开：只压高度，宽度不变。

        ⚠️ **这不是"最小化"**。用户说的最小化是"像网页那样缩到底下、完全不占屏幕"
        —— 那是 `_minimize()`（withdraw + 托盘）。760x78 的横条依然占着一整条，
        打游戏照样挡视野，所以别再把它当最小化用。
        """
        if on == self._collapsed:
            return
        # 先读真实坐标再切尺寸：_x/_y 只是启动时的缓存，拖动/缩放后已过期。
        self._sync_pos()
        if on:
            self._saved_h = self._geo.height
            self._collapsed = True
            # 先换成折叠尺寸的几何，再按它裁上一帧，否则圆角遮罩还是整窗高度
            self._set_geometry(Geometry.for_size(self._geo.width, collapsed_height()))
            self._collapsed_frame = self._geo.collapsed_frame(self._last_frame)
            self.root.geometry(f"{self._geo.width}x{self._geo.height}+{self._x}+{self._y}")
            self._layout()
        else:
            self._collapsed = False
            self._collapsed_frame = None
            self._set_geometry(Geometry.for_size(self._geo.width, max(MIN_H, self._saved_h)))
            self.root.geometry(f"{self._geo.width}x{self._geo.height}+{self._x}+{self._y}")
            self._layout(seed=True)
        self._save_geometry()

    def toggle_collapse(self, _event=None):
        """▾ / 展开：完整 ↔ 折叠横条。不落盘，重启回到完整态。"""
        self._set_collapsed(not self._collapsed)
        self._report("collapse" if self._collapsed else "expand")
        return "break"

    def toggle_danmaku(self, _event=None):
        """标题栏那个「弹」：弹幕开关，不用绕到设置页。

        写盘 + 当场挂/拆弹幕层。状态回写一行 toast（1.8 秒后自己消失）——
        标题栏上只靠颜色区分开关，光看「弹」字不知道现在是什么状态。
        """
        want = not danmaku_wanted()
        write_config({"danmaku": want})
        self._sync_danmaku()
        self._toast = "弹幕已开" if want else "弹幕已关"
        self._layout()
        try:
            self.root.after(1800, self._clear_toast)
        except Exception:
            pass
        self._report("danmaku", value=want)
        return "break"

    def _clear_toast(self) -> None:
        if not self._toast:
            return
        self._toast = ""
        try:
            self._refresh_feed()
        except Exception:
            pass

    # ---- 模式 / 弹幕 ----

    def _report(self, action: str, **fields) -> None:
        """用户动作回给宿主（`window-outbox.jsonl`）。动作名必须在 JS 侧白名单里，
        否则 `appendWindowAction` 静默返回 null —— 表现是设置页状态永远不同步、
        而且没有任何报错。"""
        try:
            if self._protocol is not None:
                self._protocol.action(action, **fields)
        except Exception:
            pass

    def _write_mode(self, mode: str) -> None:
        """`mode` 与老的 `hidden` 一起写，两个键永远一致。

        只写 mode 的话，降级回老版本窗口（只认 hidden）会读到一个过期的 `false`，
        于是「藏起来的窗」又冒出来；反过来只写 hidden，新版本就不知道是 mini。
        """
        self._mode = mode
        patch = {"hidden": mode == MODE_HIDDEN}
        drop = ()
        if mode == MODE_FULL:
            # 默认态不落盘：和 `glass: auto` 一个道理，少一个键就少一次误判
            drop = ("mode",)
        else:
            patch["mode"] = mode
        write_config(patch, drop=drop)

    def _apply_mode(self, mode: str, *, save: bool = False, cfg=None) -> None:
        """切档。`save=False` 是配置驱动的（磁盘上已经是这个值，别回写）。"""
        mode = mode if mode in WINDOW_MODES else MODE_FULL
        if mode == MODE_HIDDEN:
            self._minimize()
        else:
            self._restore()
        self._sync_danmaku(cfg)
        if save:
            self._write_mode(mode)

    def _minimize(self) -> None:
        """最小化：真的从屏幕上消失，只在托盘留一个图标。

        `overrideredirect` 的窗口不进任务栏，`withdraw()` 之后屏幕上一点痕迹都没有
        —— 所以托盘图标是这条功能的**红线**：没有它，用户只能杀进程才找得回来。
        弹幕层是独立窗口，不受这里影响（`hidden + 弹幕` 才是"打游戏"的完整形态）。
        """
        if self._hidden:
            return
        self._hidden = True
        try:
            self.root.withdraw()
        except Exception:
            self._hidden = False
            return
        if self._tray is not None:
            self._tray.show()
            # 每次运行只提示一次：Windows 11 会把新图标塞进溢出区，不告诉用户
            # "东西在哪"，他只会觉得窗口被关掉了。
            if not self._tray_hinted:
                self._tray_hinted = True
                self._tray.notify("已最小化到托盘（Ctrl+Alt+W 也能叫回来）")

    def _restore(self) -> None:
        """从托盘回来。顺手把未读清零 —— 用户点开就是想看现在有什么。"""
        if not self._hidden:
            return
        self._hidden = False
        try:
            self.root.deiconify()
            self.root.attributes("-topmost", True)
            self.root.lift()
        except Exception:
            pass
        if self._tray is not None:
            self._tray.hide()
        self._mark_read()

    def _sync_danmaku(self, cfg=None) -> None:
        """弹幕开关。开 = 一条横跨屏幕的独立窗口；关 = 连定时器一起销毁。

        弹幕层和主窗的显隐是正交的：`hidden + 弹幕` 才是"打游戏最干净"那一档。
        """
        want = danmaku_wanted(cfg) if cfg is not None else danmaku_wanted()
        opts = danmaku_options(cfg) if cfg is not None else danmaku_options()
        if want:
            if self._danmaku is None:
                try:
                    from danmaku import DanmakuLayer
                    self._danmaku = DanmakuLayer(self.root, screen_w=self._sw,
                                                 screen_h=self._sh, **opts)
                except Exception as exc:
                    self._danmaku = None
                    print("danmaku init failed", repr(exc), flush=True)
            else:
                self._danmaku.set_options(**opts)
        elif self._danmaku is not None:
            self._danmaku.close()
            self._danmaku = None

    def _push_danmaku(self) -> None:
        """把本轮新增的消息推进弹幕队列。用户自己说的话不飘。"""
        if self._danmaku is None:
            return
        for msg in getattr(self.feed, "recent", ()):
            text = msg.get("text") or ""
            if text:
                self._danmaku.push(text, msg.get("role") or "assistant")

    def _unread(self) -> int:
        return sum(1 for m in self.feed.messages
                   if (m.get("at") or 0) > self._last_read_at)

    def _mark_read(self) -> None:
        now = int(time.time() * 1000)
        self._last_read_at = now
        write_config({"lastReadAt": now})

    def _hotkey_down(self) -> bool:
        """Ctrl+Alt+W 是否按下。只在最小化时问（其它时候窗口本来就在）。"""
        if not IS_WIN:
            return False
        try:
            u = ctypes.windll.user32
            return bool((u.GetAsyncKeyState(VK_CTRL) & 0x8000)
                        and (u.GetAsyncKeyState(VK_ALT) & 0x8000)
                        and (u.GetAsyncKeyState(VK_W) & 0x8000))
        except Exception:
            return False

    def _sync_tray_tip(self) -> None:
        """最小化时把"有几条新的"写进托盘提示。

        弹幕关掉之后，托盘那行字就是**唯一**的信号 —— 没有它，用户不知道要不要点开。
        """
        if self._tray is None or not self._hidden:
            return
        n = self._unread()
        self._tray.set_tip(f"{self.name} · {n} 条新消息" if n else f"{self.name} · 点击展开")

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
            # 迷你态不画顶部那条装饰线：240 宽时它横在名字上方，像一条穿头的
            # 进度条（截图确认过）。胶囊本身已经够小，不需要再给一个视觉锚点。
            self._bar = None
            self._sync_static_frame()
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
        # 气泡宽度变了 → 形状变了 → 静态底板要重画（缓存按 shapes 命中，没变就是 0 成本）
        self._sync_static_frame()
        self.text.refresh()

    def _sync_static_frame(self) -> None:
        """静态样式：把当前尺寸/形状的底板贴上去（其余时间一帧都不算）。

        `_draw_feed()` 会在 `_layout()` 中途换掉 `self._geo`（气泡宽度跟着文字走），
        所以要在这里、在全部绘制之后再取一次帧 —— 否则贴上去的还是上一套气泡的
        底板，文字换了位置而底板没换。
        """
        if not self._static or self._collapsed or self._resize:
            return
        if self._bg is None:
            return
        try:
            frame = self._renderer.frame_for(self._geo)
        except Exception as exc:
            print("static plate error", exc, flush=True)
            return
        if frame is None or (frame is self._last_frame and self._img is not None):
            return
        self._last_frame = frame
        try:
            self._img = ImageTk.PhotoImage(frame, master=self.canvas)
            self.canvas.itemconfigure(self._bg, image=self._img)
            self.canvas.tag_lower(self._bg)
        except Exception as exc:
            print("static draw error", exc, flush=True)

    def _draw_header(self) -> None:
        c = self.canvas
        w = self._geo.width
        mic_on = self._mic_proc is not None and self._mic_proc.poll() is None
        dot = "#e05a5a" if mic_on else "#0a84ff"
        # 标题栏玻璃是 y=12..66，中心 39；右边 —/▾/✕ 也在 38。点、名字、状态必须
        # 同一条水平中线，且字号要能完整落在条内，不能压到气泡区。
        cy, dot_x, title_x = 38, 54, 68
        c.create_oval(dot_x - 9, cy - 9, dot_x + 9, cy + 9,
                      outline="#2b4d73" if dot == "#0a84ff" else "#6b3030", width=1)
        c.create_oval(dot_x - 4, cy - 4, dot_x + 4, cy + 4, fill=dot, outline="")
        name = self.name[:10]
        self.text.draw(title_x, cy, name, anchor="w", fill="#f7fbff", size=16,
                       bold=True, tags=("title",))
        count = self._toast or self.feed.status or f"{len(self.feed.messages)} 条"
        nx = title_x + self.fonts.get(16, True).measure(name) + 10
        tone = "#9fe1cb" if self._toast else ("#ffb4b4" if self.feed.status else "#dbe6f5")
        # 右边四个按钮占 176px。状态行不截断的话，一条长 meta（宿主的报错动辄
        # 七八十字）会直接糊到按钮上 —— 之前只有一个 ▾/✕ 时不明显，现在四个按钮
        # 一撞就整排看不见。
        count = self._clip_text(count, 11, max(40, (w - 176) - nx - 8))
        self.text.draw(nx, cy, count, anchor="w", fill=tone, size=11)
        # 「弹」= 弹幕开关（亮蓝 = 开，暗灰 = 关）；「—」= 最小化到托盘；
        # 「▾」= 折叠成横条；「✕」= 关闭。四个按钮，从右往左数。
        dm_on = danmaku_wanted()
        self.text.draw(w - 168, 38, "弹", anchor="w",
                       fill="#7fc4ff" if dm_on else "#55637a", size=12, tags=("danmaku",))
        self.text.draw(w - 130, 38, "—", anchor="w", fill="#7f8da3", size=13,
                       tags=("minimize",))
        self.text.draw(w - 92, 38, "▾", anchor="w", fill="#7f8da3", size=12,
                       tags=("collapse",))
        self.text.draw(w - 54, 38, "✕", anchor="w", fill="#9fb0c8", size=13, tags=("close",))

    def _clip_text(self, text: str, size: int, width: int) -> str:
        """按像素宽度截断（单行）。`_fit_lines` 是折行，标题栏不能折 —— 折下去就压气泡了。"""
        text = str(text or "")
        font = self.fonts.get(size)
        if width <= 0 or font.measure(text) <= width:
            return text
        cur = ""
        for ch in text:
            if font.measure(cur + ch + "…") > width:
                break
            cur += ch
        return (cur + "…") if cur else ""

    def _bind_header(self) -> None:
        c = self.canvas
        c.tag_bind("close", "<Button-1>", self._close)
        c.tag_bind("danmaku", "<Button-1>", self.toggle_danmaku)
        c.tag_bind("minimize", "<Button-1>",
                   lambda _e: self._apply_mode(MODE_HIDDEN, save=True))
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
                               anchor=info["ta"], fill="#a8b7c9", size=9, tags=("feed", "feedbody"))
            for li, line in enumerate(info["lines"]):
                # 气泡里有底板，文字颜色固定、再补一层 1px 深色偏移当描边
                self.text.draw(info["tx"], info["ty"] + li * info["ls"], line,
                               anchor=info["ta"], fill="#edf6ff", size=11, tags=("feed", "feedbody"),
                               shadow=PLATE, adapt=not PLATE)
            if not (info["clipped"] or info["expanded"]):
                continue
            # 截断/展开的气泡给一块透明热区（fill="" 只占事件、不画像素）和一个
            # 角标：光靠省略号看不出是被砍了，更没有入口把剩下的读出来。
            bx0, by0, bx1, by1, _r = info["shape"]
            tag = f"bubble{idx}"
            c.create_rectangle(bx0, by0, bx1, by1, fill="", outline="",
                               tags=("feed", "feedbody", "bubblehit", tag))
            self.text.draw(bx1 - 12, by1 - 11, "▴" if info["expanded"] else "▾",
                           anchor="center", fill="#9fc7ff", size=9, tags=("feed", "feedbody", tag))
            c.tag_bind(tag, "<Button-1>",
                       lambda _e, k=info["key"]: self._toggle_expand(k))
        if not shown:
            slot = self._geo.shapes[0]
            self.text.draw(w // 2, slot[1] + (slot[3] - slot[1]) // 2,
                           "在这里跟它说话 · 滚轮翻历史", anchor="center",
                           fill="#8e9db2", size=12, tags=("feed", "feedbody"))

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
        """写心跳（每秒最多一次）。

        以前写的是**空文件**，插件侧只能看 mtime —— 那只能回答"进程还在画吗"，
        回答不了"用户能不能看见"。于是出现最难受的一种状态：配置文件写
        `hidden:false`、进程活着、心跳在跳，屏幕上一片空，`status` 却说"显示中"
        （see-now issue #32 第 3 点）。

        现在把**窗口的真实可见性**一起写进去。mtime 仍然可用，老版本读法不受影响；
        内容是多出来的一份事实。

        必须原子写：插件每秒都可能读它，读到半行 JSON 会被当成"没有可见性"，
        于是退回读配置文件 —— 那正好是这一版要修的东西。
        """
        now = time.time()
        if now - getattr(self, "_beat_at", 0.0) < HEARTBEAT_EVERY:
            return
        self._beat_at = now
        try:
            HEARTBEAT.parent.mkdir(parents=True, exist_ok=True)
            tmp = HEARTBEAT.with_name("window-heartbeat.tmp")
            tmp.write_bytes(self._beat_payload(now))
            os.replace(tmp, HEARTBEAT)
        except Exception:
            pass

    def _beat_payload(self, now: float) -> bytes:
        """心跳内容：`{at, visible, hidden, state}`。

        `hidden` 是**意图**（配置文件要求藏），`visible` 是**事实**（Tk 说了算）。
        两个都要写 —— 只写事实的话，插件分不清"用户故意藏的"和"想显示但没 map 出来"。
        """
        try:
            state = str(self.root.state())
        except Exception:
            state = "unknown"
        visible = (not self._hidden) and state == "normal"
        try:
            visible = visible and bool(self.root.winfo_ismapped())
        except Exception:
            visible = False
        return json.dumps(
            {"at": round(now, 3), "visible": visible, "hidden": bool(self._hidden), "state": state},
            ensure_ascii=False,
        ).encode("utf-8")

    # ---- 主循环 ----

    def _tick(self) -> None:
        self._beat()
        if self._static:
            # 静态底板：没有帧要取、没有渐变要算。只留心跳（插件靠它判断窗口还活着）
            # 和低频定时器，CPU 占用基本为 0。
            self.root.after(500, self._tick)
            return
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

    def _work(self, stop: threading.Event) -> None:
        """抓取 + 合成全在后台，主线程只负责显示最新一帧。

        `stop` 是**这一次线程**的开关（不是 `self._stop`）：换样式时会停一次、
        再换 live 时又要起一次，共用一个 Event 的话第二次一启动就退出。
        """
        import mss

        idle = 0
        with mss.mss() as sct:
            while not stop.is_set() and not self._stop.is_set():
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
        if not IS_WIN:
            return None
        if self._hwnd is None:
            self._hwnd = ctypes.windll.user32.GetAncestor(self.root.winfo_id(), 2)
        return self._hwnd

    def _apply_no_activate(self, on: bool) -> None:
        """给窗口加 / 摘 `WS_EX_NOACTIVATE`（Windows only，见 `no_activate_wanted`）。

        加上之后点窗不激活它，Windows 也就不重排 topmost 带 —— 全屏游戏里点悬浮窗
        不会把宿主窗顶到前面（#44 第 1 条）。代价是**键盘焦点也拿不到**，所以点输入框
        时要先摘掉（`_focus_input`），而且摘掉之后本次运行不再加回：用户既然要点输入框，
        就是准备打字了，再抢走焦点只会更烦人。
        """
        if not IS_WIN:
            return
        try:
            hwnd = self._hwnd_root()
            u = ctypes.windll.user32
            ex = int(u.GetWindowLongW(hwnd, GWL_EXSTYLE))
            want = (ex | WS_EX_NOACTIVATE) if on else (ex & (~WS_EX_NOACTIVATE & 0xFFFFFFFF))
            if want != ex:
                u.SetWindowLongW(hwnd, GWL_EXSTYLE, want)
            self._no_activate_on = bool(on)
        except Exception as exc:
            self._no_activate_on = False
            print("noActivate 设置失败", repr(exc), flush=True)

    def _set_exclude(self, on: bool) -> None:
        """WDA：让窗口从屏幕捕获里消失，抓自己所在区域时抓到的是背后的桌面。

        macOS/Linux 没有这个 API，**不能抓、也不能设**：硬调就是 AttributeError。
        返回 False 之后 `_cappable` 会被打开，改走"抓到了就把自己那块填掉"那条路
        （见 `glass_capture.fill_own_rect`），否则会递归地拍到自己。
        """
        if not IS_WIN:
            self._excluded = False
            return
        hwnd = self._hwnd_root()
        fn = ctypes.windll.user32.SetWindowDisplayAffinity
        fn.argtypes = [wintypes.HWND, wintypes.DWORD]
        fn.restype = wintypes.BOOL
        ok = bool(fn(hwnd, 0x11 if on else 0))
        self._excluded = ok and on
        if not ok:
            print("WDA failed", ctypes.GetLastError(), flush=True)

    def _bbox(self):
        if not IS_WIN:
            # 非 Windows 没有 GetWindowRect；用 Tk 自己的屏幕坐标顶上。
            # Retina 上是逻辑像素，和 mss 的物理像素可能差一个缩放倍数 ——
            # 已知的遗留问题，那类机器上建议用 frost/solid（都不抓屏）。
            try:
                x, y = int(self.root.winfo_rootx()), int(self.root.winfo_rooty())
                return (x, y, x + int(self.root.winfo_width()), y + int(self.root.winfo_height()))
            except Exception:
                return (0, 0, 0, 0)
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
        """记住完整态的位置。折叠只是临时压高度，不能把 78 当成窗口尺寸存下去。

        尺寸取 `_geo` 而**不能取 `winfo_height()`**：`root.geometry()` 是异步的，
        刚设完读回来还是上一档的值（实测折叠时存成 560、展开时存成 78，正好互换）。
        """
        self._sync_pos()
        h = self._saved_h if self._collapsed else self._geo.height
        write_config({"geometry": f"{self._geo.width}x{h}+{self._x}+{self._y}"})

    # ---- 关闭 / 隐藏 ----

    def _close(self, _e=None):
        try:
            self._save_geometry()
            self._stop_mic()
            # 弹幕层和托盘都是本进程的额外窗口：不显式关的话，`root.destroy()`
            # 也会带走它们，但那些 after job 会先报一次 "invalid command name"。
            if self._danmaku is not None:
                self._danmaku.close()
                self._danmaku = None
            if self._tray is not None:
                self._tray.close()
                self._tray = None
            self._stop.set()
            self._pause.set()
            self._set_exclude(False)
            self._stop_worker()
            try:
                self._renderer.close()
            except Exception:
                pass
            if IS_WIN:
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
        # 麦克风图标画在玻璃里，不在 Canvas 上单独建控件；点它不能当拖窗。
        # **迷你态没有麦克风**：`mic_pos` 是按高度算的（h-67），78 高时落在标题栏
        # 左侧，点名字附近就会误开麦（折叠态一直有这个毛病）。
        if not self._collapsed:
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
