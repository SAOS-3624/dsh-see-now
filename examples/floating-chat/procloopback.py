#!/usr/bin/env python3
"""procloopback.py — WASAPI **per-process loopback** 的纯 Python 实现（Windows 10 2004+）。

## 它解决什么

`listen.py` 现在用 pyaudiowpatch 抓**设备回环**：整台机器放出来的声音全进一条流，
于是 AI 自己的 TTS 也被收回去，转成"视频里的台词"（`quiet-until` 那套装聋就是补这个）。
按进程分轨之后，只抓浏览器/播放器那一棵进程树，TTS 从别的进程出来的声音根本进不来。

## 为什么是纯 ctypes，不是 C# / comtypes

`ActivateAudioInterfaceAsync` 是 Win32 COM，不是 .NET 独有的能力（issue #34 第一条回复
的判断是对的）；本文连 comtypes 都不用 —— ctypes 搓一个 4 槽 vtable 就能当
`IActivateAudioInterfaceCompletionHandler` 用，插件因此**不增加任何运行时依赖**
（Python 自带的 ctypes + numpy 就够，numpy 本来就在）。

实测（2026-11-07，Win11 22621.6060 / Python 3.13）：

  · 两个 ffplay 同时放 440Hz / 660Hz，抓 A：440Hz=0.0388、660Hz=0.0000；
    反向抓 B：660Hz=0.0432、440Hz=0.0000 —— 隔离干净，没有串音；
  · 父进程自己不发声、子进程 ffplay 放 880Hz：抓父 PID 得到 880Hz=0.0434 ——
    `INCLUDE_TARGET_PROCESS_TREE` 生效，Chrome 的 audio utility 子进程同理；
  · 静音目标照样有数据包（内容是 0），所以断句只能按能量判，不能等"没包"。

## 两个必须踩住的坑

1. 完成回调那个 COM 对象**必须同时实现 IAgileObject**（空接口）。少答它，
   `ActivateAudioInterfaceAsync` 返回 `E_ILLEGAL_METHOD_CALL`，而且不说原因。
2. `Initialize` 不受"共享模式必须用混音格式"的限制：进程回环是虚拟设备，
   16k / 单声道 / s16 直接要，省掉热路径重采样（`listen.py` 的 Segmenter 就吃这个）。

## 用法

被 `listen.py` 当模块用（`--source process`）；也可以单独跑：

    python procloopback.py --list                     # 列出当前有音频会话的进程
    python procloopback.py --process chrome.exe --seconds 3 --out cap.wav
    python procloopback.py --pid 1234 --seconds 3 --out cap.wav

退出码：0 正常，2 参数/环境问题，1 激活或采集失败。
"""

import argparse
import ctypes
import ctypes.wintypes as wt
import os
import sys
import time
import uuid
import wave


# ── COM 基础设施 ────────────────────────────────────────────────────────────

HRESULT = ctypes.c_long
S_OK = 0
E_NOINTERFACE = -2147467262  # 0x80004002

IID_UNKNOWN = uuid.UUID("00000000-0000-0000-C000-000000000046")
IID_IHANDLER = uuid.UUID("41D949AB-9862-444A-80F6-C261334DA5EB")
IID_IAGILE = uuid.UUID("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90")
IID_IAUDIOCLIENT = uuid.UUID("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2")
IID_IAUDIOCAPTURECLIENT = uuid.UUID("C8ADBD64-E71E-48A0-A4DE-185C395CD317")

CLSID_MMDEVICE_ENUMERATOR = uuid.UUID("BCDE0395-E52F-467C-8E3D-C4579291692E")
IID_IMMDEVICE_ENUMERATOR = uuid.UUID("A95664D2-9614-4F35-A746-DE8DB63617E6")
IID_IMMDEVICE = uuid.UUID("D666063F-1587-4E43-81F1-B948E807363F")
IID_IAUDIOSESSIONMANAGER2 = uuid.UUID("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")
IID_IAUDIOSESSIONENUMERATOR = uuid.UUID("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")
IID_IAUDIOSESSIONCONTROL2 = uuid.UUID("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")
IID_IAUDIOMETER = uuid.UUID("C02216F6-8C67-4B5B-9D00-D008E73E0064")

VT_BLOB = 65
AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0

AUDCLNT_SHAREMODE_SHARED = 0
AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
AUDCLNT_BUFFERFLAGS_SILENT = 0x2
CLSCTX_ALL = 0x17
AUDIO_SESSION_STATE_ACTIVE = 1


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_uint32),
        ("Data2", ctypes.c_uint16),
        ("Data3", ctypes.c_uint16),
        ("Data4", ctypes.c_ubyte * 8),
    ]

    def __init__(self, value=None):
        super().__init__()
        if value is not None:
            ctypes.memmove(ctypes.byref(self), uuid.UUID(str(value)).bytes_le, 16)

    def raw(self):
        return ctypes.string_at(ctypes.byref(self), 16)


class PROCESS_LOOPBACK_PARAMS(ctypes.Structure):
    _fields_ = [
        ("TargetProcessId", wt.DWORD),
        ("ProcessLoopbackMode", ctypes.c_int),
    ]


class ACTIVATION_PARAMS(ctypes.Structure):
    _fields_ = [
        ("ActivationType", ctypes.c_int),
        ("ProcessLoopbackParams", PROCESS_LOOPBACK_PARAMS),
    ]


class PROPVARIANT_BLOB(ctypes.Structure):
    # vt = VT_BLOB 时的 PROPVARIANT：8 字节头 + BLOB{ULONG cbSize; BYTE *pBlobData;}
    _fields_ = [
        ("vt", ctypes.c_ushort),
        ("r1", ctypes.c_ushort),
        ("r2", ctypes.c_ushort),
        ("r3", ctypes.c_ushort),
        ("cbSize", wt.ULONG),
        ("pBlobData", ctypes.c_void_p),
    ]


class WAVEFORMATEX(ctypes.Structure):
    _fields_ = [
        ("wFormatTag", wt.WORD),
        ("nChannels", wt.WORD),
        ("nSamplesPerSec", wt.DWORD),
        ("nAvgBytesPerSec", wt.DWORD),
        ("nBlockAlign", wt.WORD),
        ("wBitsPerSample", wt.WORD),
        ("cbSize", wt.WORD),
    ]


QI_FN = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))
REF_FN = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)
ACT_FN = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.c_void_p)


class _VtblObject(ctypes.Structure):
    _fields_ = [("vtbl", ctypes.POINTER(ctypes.c_void_p))]


def _com_slot(ptr, index, argtypes, restype=HRESULT):
    """把 COM 接口的第 index 个 vtable 槽取成可调用原型。"""
    vtbl = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    proto = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
    return proto(vtbl[index])


def _release(ptr):
    if not ptr or not ptr.value:
        return
    try:
        _com_slot(ptr, 2, [])(ptr)
    except Exception:
        pass


def _query_interface(ptr, iid):
    qi = _com_slot(ptr, 0, [ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)])
    out = ctypes.c_void_p()
    guid = GUID(iid)
    hr = qi(ptr, ctypes.byref(guid), ctypes.byref(out))
    return hr, out


def _co_initialize():
    try:
        ctypes.WinDLL("ole32").CoInitializeEx(None, 0x0)  # COINIT_MULTITHREADED
    except Exception:
        pass


def _co_uninitialize():
    try:
        ctypes.WinDLL("ole32").CoUninitialize()
    except Exception:
        pass


# ── 进程表（Toolhelp32）：按名字找 PID、判断还活着 ─────────────────────────

TH32CS_SNAPPROCESS = 0x2
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD),
        ("cntUsage", wt.DWORD),
        ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD),
        ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wt.DWORD),
        ("szExeFile", wt.WCHAR * 260),
    ]


def iter_processes():
    """(pid, 可执行文件名) 的列表。失败返回空列表（不抛）。"""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    kernel32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
    kernel32.Process32FirstW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.CloseHandle.argtypes = [wt.HANDLE]

    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap in (None, wt.HANDLE(-1).value):
        return []
    rows = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            rows.append((int(entry.th32ProcessID), entry.szExeFile))
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return rows


def _norm(name):
    base = os.path.basename(str(name or "")).lower()
    return base[:-4] if base.endswith(".exe") else base


def find_pids(process_name):
    """按进程名（带不带 .exe 都行，大小写不敏感）找 PID，按进程表顺序。"""
    want = _norm(process_name)
    if not want:
        return []
    return [pid for pid, name in iter_processes() if _norm(name) == want]


def pid_name(pid):
    for p, name in iter_processes():
        if p == pid:
            return name
    return ""


def is_alive(pid):
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wt.HANDLE
    kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return False
    try:
        code = wt.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


# ── 音频会话枚举：自动找"正在出声的那个进程" ───────────────────────────────

def audio_sessions():
    """当前默认输出设备上**有音频会话**的进程。

    返回 `[{pid, name, peak, state}]`，`peak` 是会话的瞬时峰值（0~1）。
    Chrome 的会话 PID 是 audio utility 子进程（实测不等于浏览器主进程）——
    所以这里拿到的 PID 直接喂给 process loopback 就够了，它自带进程树。

    失败（没有设备、权限、老系统）返回空列表，调用方回退设备回环。
    """
    _co_initialize()
    enumerator = ctypes.c_void_p()
    try:
        ole32 = ctypes.WinDLL("ole32")
        ole32.CoCreateInstance.argtypes = [
            ctypes.POINTER(GUID), ctypes.c_void_p, wt.DWORD,
            ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p),
        ]
        clsid = GUID(CLSID_MMDEVICE_ENUMERATOR)
        iid = GUID(IID_IMMDEVICE_ENUMERATOR)
        hr = ole32.CoCreateInstance(ctypes.byref(clsid), None, CLSCTX_ALL,
                                    ctypes.byref(iid), ctypes.byref(enumerator))
        if hr != S_OK or not enumerator.value:
            return []

        # IMMDeviceEnumerator::GetDefaultAudioEndpoint(eRender, eConsole)
        get_default = _com_slot(enumerator, 4, [ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)])
        device = ctypes.c_void_p()
        hr = get_default(enumerator, 0, 0, ctypes.byref(device))
        if hr != S_OK or not device.value:
            return []
        try:
            activate = _com_slot(device, 3, [ctypes.POINTER(GUID), wt.DWORD,
                                             ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)])
            mgr_iid = GUID(IID_IAUDIOSESSIONMANAGER2)
            manager = ctypes.c_void_p()
            hr = activate(device, ctypes.byref(mgr_iid), CLSCTX_ALL, None, ctypes.byref(manager))
            if hr != S_OK or not manager.value:
                return []
            try:
                get_enum = _com_slot(manager, 5, [ctypes.POINTER(ctypes.c_void_p)])
                sessions = ctypes.c_void_p()
                hr = get_enum(manager, ctypes.byref(sessions))
                if hr != S_OK or not sessions.value:
                    return []
                try:
                    get_count = _com_slot(sessions, 3, [ctypes.POINTER(ctypes.c_int)])
                    get_session = _com_slot(sessions, 4, [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)])
                    count = ctypes.c_int(0)
                    if get_count(sessions, ctypes.byref(count)) != S_OK:
                        return []
                    rows = []
                    for i in range(count.value):
                        control = ctypes.c_void_p()
                        if get_session(sessions, i, ctypes.byref(control)) != S_OK or not control.value:
                            continue
                        try:
                            state = ctypes.c_int(0)
                            _com_slot(control, 3, [ctypes.POINTER(ctypes.c_int)])(control, ctypes.byref(state))
                            hr, control2 = _query_interface(control, IID_IAUDIOSESSIONCONTROL2)
                            if hr != S_OK or not control2.value:
                                continue
                            try:
                                proc_id = wt.DWORD(0)
                                _com_slot(control2, 14, [ctypes.POINTER(wt.DWORD)])(
                                    control2, ctypes.byref(proc_id))
                                peak = 0.0
                                hr_m, meter = _query_interface(control2, IID_IAUDIOMETER)
                                if hr_m == S_OK and meter.value:
                                    try:
                                        value = ctypes.c_float(0.0)
                                        _com_slot(meter, 3, [ctypes.POINTER(ctypes.c_float)])(
                                            meter, ctypes.byref(value))
                                        peak = float(value.value)
                                    finally:
                                        _release(meter)
                                rows.append({
                                    "pid": int(proc_id.value),
                                    "name": pid_name(int(proc_id.value)),
                                    "peak": peak,
                                    "state": int(state.value),
                                })
                            finally:
                                _release(control2)
                        finally:
                            _release(control)
                    return rows
                finally:
                    _release(sessions)
            finally:
                _release(manager)
        finally:
            _release(device)
    except Exception:
        return []
    finally:
        _release(enumerator)
        _co_uninitialize()


#: 这些是**播放器/合成器**：TTS 常从这里出声，自动模式必须排除，否则会"只听自己"。
PLAYER_NAMES = frozenset({
    "ffplay", "ffmpeg", "vlc", "wmplayer", "mplayer",
    "sapi", "powershell", "pwsh", "cmd",  # SAPI 走 powershell -c 的情况下
})


def auto_target(exclude_pids=(), exclude_names=PLAYER_NAMES, min_peak=0.0005):
    """自动挑"正在出声、且不是播放器/自己"的进程。返回 dict 或 None。

    排序用会话峰值，不按进程名猜 —— 同一个浏览器可能同时有多个会话。
    """
    excluded = {int(p) for p in exclude_pids}
    rows = [r for r in audio_sessions()
            if r["pid"] and r["pid"] not in excluded and r["state"] == AUDIO_SESSION_STATE_ACTIVE
            and r["peak"] >= min_peak and _norm(r["name"]) not in exclude_names]
    if not rows:
        return None
    rows.sort(key=lambda r: r["peak"], reverse=True)
    return rows[0]


# ── 进程回环本体 ───────────────────────────────────────────────────────────

class TargetGone(RuntimeError):
    """目标进程没了（退出/被杀）—— 上层据此重新解析 PID 或回退设备回环。"""


def _activation_handler():
    """一个 4 槽 vtable 的 COM 对象：IUnknown 三个 + ActivateCompleted。"""
    state = {"event": None, "hr": None, "activate_result": None, "unknown": None}
    import threading
    state["event"] = threading.Event()

    @QI_FN
    def qi(this, riid, ppv):
        try:
            want = riid.contents.raw()
        except Exception:
            return E_NOINTERFACE
        if want in (IID_UNKNOWN.bytes_le, IID_IHANDLER.bytes_le, IID_IAGILE.bytes_le):
            ppv[0] = this
            return S_OK
        ppv[0] = None
        return E_NOINTERFACE

    @REF_FN
    def addref(this):
        return 2

    @REF_FN
    def release(this):
        return 1

    @ACT_FN
    def activate_completed(this, operation):
        try:
            # IActivateAudioInterfaceAsyncOperation::GetActivateResult(HRESULT*, IUnknown**)
            slot = _com_slot(operation, 3, [ctypes.POINTER(HRESULT), ctypes.POINTER(ctypes.c_void_p)])
            result = HRESULT(0)
            unknown = ctypes.c_void_p()
            state["hr"] = slot(operation, ctypes.byref(result), ctypes.byref(unknown))
            state["activate_result"] = result.value
            state["unknown"] = unknown
        except Exception as exc:   # 绝不把异常抛回 COM
            state["hr"] = -1
            state["error"] = repr(exc)
        finally:
            state["event"].set()
        return S_OK

    callbacks = [qi, addref, release, activate_completed]
    vtbl = (ctypes.c_void_p * 4)(*[ctypes.cast(cb, ctypes.c_void_p).value for cb in callbacks])
    holder = _VtblObject(vtbl=ctypes.cast(vtbl, ctypes.POINTER(ctypes.c_void_p)))
    this = ctypes.cast(ctypes.pointer(holder), ctypes.c_void_p)
    return {"holder": holder, "vtbl": vtbl, "callbacks": callbacks, "this": this, "state": state}


def _activate_process_loopback(pid):
    """返回 (IAudioClient*, keepalive)。失败抛 OSError（带 HRESULT）。"""
    _co_initialize()
    mmdevapi = ctypes.WinDLL("mmdevapi")
    activate = mmdevapi.ActivateAudioInterfaceAsync
    activate.argtypes = [
        wt.LPCWSTR, ctypes.POINTER(GUID), ctypes.POINTER(PROPVARIANT_BLOB),
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
    ]
    activate.restype = HRESULT

    params = ACTIVATION_PARAMS(
        ActivationType=AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        ProcessLoopbackParams=PROCESS_LOOPBACK_PARAMS(
            TargetProcessId=int(pid),
            ProcessLoopbackMode=PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
        ),
    )
    prop = PROPVARIANT_BLOB(
        vt=VT_BLOB, r1=0, r2=0, r3=0,
        cbSize=ctypes.sizeof(params),
        pBlobData=ctypes.cast(ctypes.byref(params), ctypes.c_void_p),
    )

    handler = _activation_handler()
    riid = GUID(IID_IAUDIOCLIENT)
    operation = ctypes.c_void_p()
    hr = activate("VAD\\Process_Loopback", ctypes.byref(riid), ctypes.byref(prop),
                  handler["this"], ctypes.byref(operation))
    if hr != S_OK:
        raise OSError(f"ActivateAudioInterfaceAsync 失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")
    if not operation.value:
        raise OSError("ActivateAudioInterfaceAsync 返回空操作")
    if not handler["state"]["event"].wait(10.0):
        raise OSError("等待激活回调超时")
    if handler["state"]["hr"] != S_OK:
        raise OSError(f"GetActivateResult 失败：HRESULT 0x{handler['state']['hr'] & 0xFFFFFFFF:08X}")
    if handler["state"]["activate_result"] != S_OK:
        raise OSError(f"激活结果：HRESULT 0x{handler['state']['activate_result'] & 0xFFFFFFFF:08X}")

    unknown = handler["state"]["unknown"]
    if not unknown or not unknown.value:
        raise OSError("激活没有返回接口")
    hr, audio_client = _query_interface(unknown, IID_IAUDIOCLIENT)
    _release(unknown)
    if hr != S_OK or not audio_client.value:
        raise OSError(f"QueryInterface(IAudioClient) 失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")
    return audio_client, handler


class ProcessLoopback:
    """按进程抓音频。用法：

        cap = ProcessLoopback(pid)
        cap.open()
        for block in cap.read():   # list[np.float32]，16k 单声道
            ...
        cap.close()

    目标静音时**仍然有包**（内容是 0），所以断句按能量判；目标进程退出时
    下一次 `read()` 抛 `TargetGone`，上层重新解析 PID 或回退设备回环。
    """

    def __init__(self, pid, rate=16000, channels=1, bits=16):
        self.pid = int(pid)
        self.rate = rate
        self.channels = channels
        self.bits = bits
        self.audio_client = ctypes.c_void_p()
        self.capture_client = ctypes.c_void_p()
        self._handler = None
        self._started = False
        self._last_alive_check = 0.0
        self._block_align = channels * bits // 8

    # -- 生命周期 --
    def open(self):
        audio_client, handler = _activate_process_loopback(self.pid)
        self.audio_client = audio_client
        self._handler = handler
        try:
            self._initialize()
            self._get_capture_client()
            self._start()
        except Exception:
            self.close()
            raise
        return self

    def _initialize(self):
        wfx = WAVEFORMATEX(
            wFormatTag=1,
            nChannels=self.channels,
            nSamplesPerSec=self.rate,
            nAvgBytesPerSec=self.rate * self._block_align,
            nBlockAlign=self._block_align,
            wBitsPerSample=self.bits,
            cbSize=0,
        )
        initialize = _com_slot(
            self.audio_client, 3,
            [ctypes.c_int, wt.DWORD, ctypes.c_longlong, ctypes.c_longlong,
             ctypes.POINTER(WAVEFORMATEX), ctypes.c_void_p],
        )
        # 共享模式 + LOOPBACK；进程回环是虚拟设备，格式自定（见模块头注释）。
        hr = initialize(self.audio_client, AUDCLNT_SHAREMODE_SHARED,
                        AUDCLNT_STREAMFLAGS_LOOPBACK, 0, 0, ctypes.byref(wfx), None)
        if hr != S_OK:
            raise OSError(f"IAudioClient::Initialize 失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")

    def _get_capture_client(self):
        get_service = _com_slot(self.audio_client, 14,
                                [ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)])
        iid = GUID(IID_IAUDIOCAPTURECLIENT)
        client = ctypes.c_void_p()
        hr = get_service(self.audio_client, ctypes.byref(iid), ctypes.byref(client))
        if hr != S_OK or not client.value:
            raise OSError(f"GetService(IAudioCaptureClient) 失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")
        self.capture_client = client

    def _start(self):
        hr = _com_slot(self.audio_client, 10, [])(self.audio_client)
        if hr != S_OK:
            raise OSError(f"IAudioClient::Start 失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")
        self._started = True

    def close(self):
        if self._started and self.audio_client:
            try:
                _com_slot(self.audio_client, 11, [])(self.audio_client)
            except Exception:
                pass
            self._started = False
        _release(self.capture_client)
        self.capture_client = ctypes.c_void_p()
        _release(self.audio_client)
        self.audio_client = ctypes.c_void_p()
        _co_uninitialize()

    # -- 采集 --
    def read(self, timeout=0.1):
        """取一批音频块（每块 ≈ 一个 WASAPI 包，通常 100ms）。

        返回 `list[np.ndarray]`（float32，[-1,1]）。超过 `timeout` 没包返回空列表。
        """
        import numpy as np

        now = time.monotonic()
        if now - self._last_alive_check > 1.0:
            self._last_alive_check = now
            if not is_alive(self.pid):
                raise TargetGone(f"目标进程 {self.pid} 已经不在了")

        get_next = _com_slot(self.capture_client, 5, [ctypes.POINTER(wt.UINT)])
        get_buffer = _com_slot(
            self.capture_client, 3,
            [ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wt.UINT), ctypes.POINTER(wt.DWORD),
             ctypes.POINTER(ctypes.c_ulonglong), ctypes.POINTER(ctypes.c_ulonglong)],
        )
        release_buffer = _com_slot(self.capture_client, 4, [wt.UINT])

        blocks = []
        deadline = now + timeout
        while time.monotonic() < deadline:
            n = wt.UINT(0)
            hr = get_next(self.capture_client, ctypes.byref(n))
            if hr != S_OK:
                raise TargetGone(f"取包失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")
            if n.value == 0:
                break
            got = False
            while n.value:
                data = ctypes.c_void_p()
                frames = wt.UINT(0)
                flags = wt.DWORD(0)
                dev_pos = ctypes.c_ulonglong(0)
                qpc_pos = ctypes.c_ulonglong(0)
                hr = get_buffer(self.capture_client, ctypes.byref(data), ctypes.byref(frames),
                                ctypes.byref(flags), ctypes.byref(dev_pos), ctypes.byref(qpc_pos))
                if hr != S_OK:
                    raise TargetGone(f"读包失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")
                count = frames.value
                if count:
                    if flags.value & AUDCLNT_BUFFERFLAGS_SILENT or not data.value:
                        pcm = np.zeros(count, dtype=np.int16)
                    else:
                        raw = ctypes.string_at(data.value, count * self._block_align)
                        pcm = np.frombuffer(raw, dtype="<i2")
                    blocks.append(pcm.astype(np.float32) / 32768.0)
                    got = True
                release_buffer(self.capture_client, count)
                n = wt.UINT(0)
                if get_next(self.capture_client, ctypes.byref(n)) != S_OK:
                    break
            if got:
                break
            time.sleep(0.005)
        return blocks


def capture_to_wav(pid, seconds, out_path, rate=16000):
    """CLI 用：抓 `seconds` 秒落成 16k 单声道 wav。"""
    cap = ProcessLoopback(pid, rate=rate).open()
    chunks = []
    try:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            for block in cap.read(timeout=0.2):
                chunks.append(block)
    finally:
        cap.close()
    import numpy as np
    audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(out_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return len(pcm) / rate


def main(argv=None):
    ap = argparse.ArgumentParser(description="WASAPI per-process loopback（纯 ctypes）")
    ap.add_argument("--pid", type=int, default=None)
    ap.add_argument("--process", default=None, help="进程名，如 chrome.exe")
    ap.add_argument("--seconds", type=float, default=3.0)
    ap.add_argument("--out", default="procloopback.wav")
    ap.add_argument("--rate", type=int, default=16000)
    ap.add_argument("--list", action="store_true", help="列出当前有音频会话的进程")
    args = ap.parse_args(argv)

    if args.list:
        rows = audio_sessions()
        if not rows:
            print("没有枚举到音频会话（没有默认输出设备？）")
            return 2
        rows.sort(key=lambda r: r["peak"], reverse=True)
        for r in rows:
            print(f'{r["pid"]:>7}  peak={r["peak"]:.4f}  state={r["state"]}  {r["name"]}')
        return 0

    pid = args.pid
    if pid is None:
        if args.process:
            pids = find_pids(args.process)
            if not pids:
                print(f"找不到进程：{args.process}", file=sys.stderr)
                return 2
            pid = pids[0]
        else:
            target = auto_target(exclude_pids={os.getpid()})
            if not target:
                print("没找到正在出声的进程（用 --pid/--process 指定）", file=sys.stderr)
                return 2
            pid = target["pid"]
            print(f'自动选中 {target["name"]} (pid={pid}, peak={target["peak"]:.4f})', file=sys.stderr)

    try:
        seconds = capture_to_wav(pid, args.seconds, args.out, rate=args.rate)
    except TargetGone as exc:
        print(f"目标进程提前退出：{exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"激活/采集失败：{exc}", file=sys.stderr)
        return 1
    print(f"wrote {args.out}: {seconds:.2f}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
