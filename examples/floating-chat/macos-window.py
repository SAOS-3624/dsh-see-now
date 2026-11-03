#!/usr/bin/env python3
"""See Now macOS 独立入口：仅用标准库，不加载 Windows 窗口。"""
import json
import os
import queue
import signal
import sys
import threading
from macos import MacFloatChat

DSH_SEE_WINDOW_PROTOCOL = 1
DSH_SEE_WINDOW_COMMANDS = 1
MAX_MESSAGE_BYTES = 8192


def notify(state, reason=None):
    try:
        print("DSH_SEE_WINDOW " + json.dumps({"version": 1, "state": state, "reason": reason}), flush=True)
    except BrokenPipeError:
        pass  # 独立 CLI 退出后窗口继续聊天，无需回传通知


def command(action, **fields):
    print("DSH_SEE_WINDOW " + json.dumps({"version": 1, "command": action, **fields}, ensure_ascii=False), flush=True)


def read_config():
    try:
        with open(CONFIG, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def write_config(patch):
    value = read_config()
    value.update(patch)
    os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
    temporary = CONFIG + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)
    os.replace(temporary, CONFIG)


def append_user(text):
    import time
    os.makedirs(os.path.dirname(CHAT_FILE), exist_ok=True)
    with open(CHAT_FILE, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"role": "user", "text": text, "at": int(time.time() * 1000)}, ensure_ascii=False) + "\n")


def read_states(inbox):
    """只在工作线程读 stdin，所有 Tk 操作回到主线程。"""
    while True:
        raw = sys.stdin.buffer.readline(MAX_MESSAGE_BYTES + 1)
        if not raw:
            if inbox.full():
                try:
                    inbox.get_nowait()
                except queue.Empty:
                    pass
            inbox.put(None)
            return
        if len(raw) > MAX_MESSAGE_BYTES:
            while raw and not raw.endswith(b"\n"):
                raw = sys.stdin.buffer.readline(MAX_MESSAGE_BYTES + 1)
            continue
        try:
            message = json.loads(raw)
            if isinstance(message, dict) and type(message.get("version")) is int and message["version"] == 1 and isinstance(message.get("state"), dict):
                if inbox.full():
                    inbox.get_nowait()
                inbox.put_nowait(message["state"])
        except (ValueError, TypeError, queue.Empty, queue.Full):
            continue


def drain_states(app, inbox):
    if app._see_closed:
        return
    try:
        while True:
            state = inbox.get_nowait()
            if state is None:
                app.close("stopped")
                return
            app.apply_state(state)
    except queue.Empty:
        app.root.after(80, lambda: drain_states(app, inbox))


def ready(app):
    if app.root.winfo_viewable():
        notify("ready")
    else:
        app.root.after(40, lambda: ready(app))


HOME = os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")
CONFIG = os.environ.get("DSH_SEE_WINDOW_CONFIG") or os.path.join(HOME, "see-window.json")
CHAT_FILE = os.path.join(os.environ.get("DSH_VIDEO_CACHE_DIR") or os.path.join(HOME, "see-now"), "chat.jsonl")

if __name__ == "__main__":
    app = None
    try:
        app = MacFloatChat(CHAT_FILE, read_config, write_config, append_user, notify, command)
        app.root.protocol("WM_DELETE_WINDOW", app.close)
        app.root.createcommand("tk::mac::Quit", app.close)
        signal.signal(signal.SIGTERM, lambda *_: app.root.after(0, lambda: app.close("stopped")))
        if os.environ.get("DSH_SEE_WINDOW_STANDALONE") == "1":
            app.controls.pack_forget()
            app.subtitle.configure(text="独立聊天窗口 · 播放控制请从 See Now 启动")
        else:
            inbox = queue.Queue(maxsize=8)
            threading.Thread(target=read_states, args=(inbox,), daemon=True).start()
            app.root.after(80, lambda: drain_states(app, inbox))
        app.root.after_idle(lambda: ready(app))
        app.root.mainloop()
    except BaseException as error:
        notify("failed", str(error))
        raise
