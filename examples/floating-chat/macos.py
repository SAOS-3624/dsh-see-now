"""macOS 悬浮对话窗：原生标题栏、可选择的对话和标准中文输入控件。"""
import json
import os
import time
import math
import re
import tkinter as tk
from tkinter import font as tkfont, filedialog


def rounded(canvas, x, y, w, h, radius, **options):
    """用同一轮廓绘制安静的圆角控件，避开 Aqua 的独立灰底。"""
    r = min(radius, w / 2, h / 2)
    points = [x+r,y, x+r,y, x+w-r,y, x+w-r,y, x+w,y, x+w,y+r, x+w,y+r,
              x+w,y+h-r, x+w,y+h-r, x+w,y+h, x+w-r,y+h, x+w-r,y+h,
              x+r,y+h, x+r,y+h, x,y+h, x,y+h-r, x,y+h-r,
              x,y+r, x,y+r, x,y, x+r,y]
    return canvas.create_polygon(points, smooth=True, splinesteps=24, **options)


class QuietButton(tk.Canvas):
    """轻量按钮；保留键盘焦点、禁用状态及菜单入口。"""

    def __init__(self, parent, text, command, font, width=64, primary=False):
        super().__init__(parent, width=width, height=28, bd=0, highlightthickness=0, takefocus=True)
        self.label, self.action, self.primary = text, command, primary
        self.enabled, self.hovered, self.focused = True, False, False
        self.colors = {"background":"#f6f6f7", "surface":"#e9e9ec", "text":"#27272a", "muted":"#929299", "accent":"#335f9a", "primary":"#27272a", "on_primary":"#ffffff"}
        self.bind("<Configure>", self.draw)
        self.bind("<Enter>", lambda _e: self._hover(True))
        self.bind("<Leave>", lambda _e: self._hover(False))
        self.bind("<ButtonPress-1>", self.press)
        self.bind("<ButtonRelease-1>", self.release)
        self.bind("<space>", lambda _e: self.invoke())
        self.bind("<Return>", lambda _e: self.invoke())
        self.bind("<FocusIn>", lambda _e: self._focus(True))
        self.bind("<FocusOut>", lambda _e: self._focus(False))
        self.button_font = font

    def _hover(self, value):
        self.hovered = value
        self.draw()

    def _focus(self, value):
        self.focused = value
        self.draw()

    def press(self, _event):
        self.armed = self.enabled
        if self.enabled:
            self.focus_set()

    def release(self, event):
        pressed = getattr(self, "armed", False)
        self.armed = False
        if pressed and 0 <= event.x < self.winfo_width() and 0 <= event.y < self.winfo_height():
            return self.invoke()
        return "break"

    def invoke(self):
        if self.enabled:
            self.action()
        return "break"

    def configure(self, cnf=None, **options):
        if "text" in options:
            self.label = options.pop("text")
        if "state" in options:
            self.enabled = options.pop("state") != "disabled"
        super().configure(cnf, **options)
        self.draw()

    def draw(self, _event=None):
        c = self.colors
        super().configure(bg=c["background"], cursor="pointinghand" if self.enabled else "arrow")
        self.delete("all")
        w, h = self.winfo_width(), self.winfo_height()
        fill = c["primary"] if self.primary and self.enabled else c["surface"] if self.hovered and self.enabled else c["background"]
        ink = c["on_primary"] if self.primary and self.enabled else c["text"] if self.enabled else c["muted"]
        rounded(self, 1, 1, w-2, h-2, 8, fill=fill, outline=c["accent"] if self.focused else fill, width=1)
        self.create_text(w/2, h/2, text=self.label, fill=ink, font=self.button_font)


class Timeline(tk.Canvas):
    """单条读取进度；鼠标和方向键都可以定位。"""

    def __init__(self, parent):
        super().__init__(parent, height=16, bd=0, highlightthickness=0, takefocus=True)
        self.position, self.end, self.enabled = 0, 1, False
        self.background, self.track, self.ink = "#f6f6f7", "#d8d8df", "#335f9a"
        self.bind("<Configure>", self.draw)
        self.bind("<ButtonPress-1>", self.move)
        self.bind("<B1-Motion>", self.move)
        self.bind("<Left>", lambda _e: self.step(-5))
        self.bind("<Right>", lambda _e: self.step(5))

    def configure(self, cnf=None, **options):
        if "to" in options:
            self.end = options.pop("to")
        if "state" in options:
            self.enabled = options.pop("state") != "disabled"
        super().configure(cnf, **options)
        self.draw()

    def set(self, value):
        self.position = max(0, min(self.end, value))
        self.draw()

    def get(self):
        return self.position

    def move(self, event):
        if self.enabled:
            self.focus_set()
            self.set((event.x-4) / max(1, self.winfo_width()-8) * self.end)

    def step(self, delta):
        if self.enabled:
            self.set(self.position + delta)
            self.event_generate("<<Seek>>")
        return "break"

    def draw(self, _event=None):
        super().configure(bg=self.background)
        self.delete("all")
        width, y = max(8, self.winfo_width()), 8
        end = 4 + (width-8) * self.position/max(1, self.end)
        self.create_line(4,y,width-4,y, fill=self.track, width=3, capstyle="round")
        if self.enabled:
            self.create_line(4,y,end,y, fill=self.ink, width=3, capstyle="round")
            self.create_oval(end-4,y-4,end+4,y+4, fill=self.ink, outline="")


class MacFloatChat:
    """复用宿主注入的聊天文件和配置协议，窗口只负责文字交互。"""

    def __init__(self, chat_file, read_config, write_config, append_user, notify, command=None):
        self.chat_file = chat_file
        self.write_config = write_config
        self.append_user = append_user
        self.notify = notify
        self.command = command or (lambda *_args, **_fields: None)
        self.state = {}
        self._seeking = False
        config = read_config()
        self._see_closed = False
        self._glass_stop = False
        self._offset = 0
        self._carry = b""
        self._poll_job = None
        self._count = 0
        self._collapsed = False
        self.root = tk.Tk()
        self.root.title("See Now · 视频对话")
        self.root.configure(bg="#f3f4f6")
        self.pinned = tk.BooleanVar(value=config.get("topmost", True))
        self.root.attributes("-topmost", self.pinned.get())
        self.root.minsize(400, 480)
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        width, height = min(460, sw - 32), min(760, sh - 100)
        x, y = max(16, sw - width - 28), max(40, sh - height - 70)
        saved = re.fullmatch(r"(\d+)x(\d+)\+(-?\d+)\+(-?\d+)", str(config.get("geometry", "")))
        if saved:
            width, height, x, y = map(int, saved.groups())
            width, height = max(400, min(sw - 32, width)), max(480, min(sh - 100, height))
            x, y = max(0, min(sw - width, x)), max(32, min(sh - height - 40, y))
        self.root.geometry(f"{width}x{height}+{x}+{y}")
        self.theme = tk.StringVar(value=config.get("theme") if config.get("theme") in ("system", "light", "dark") else "system")
        self.quality = tk.StringVar(value="standard")
        self.pace = tk.StringVar(value="normal")
        families = set(tkfont.families(self.root))
        self.family = "PingFang SC" if "PingFang SC" in families else "Helvetica Neue"
        self.body_font = (self.family, 14)
        self.small_font = (self.family, 11)
        self._build()
        self._apply_theme(save=False)
        self.apply_state({})
        self._load_history()
        self.poll()
        self.root.bind("<Command-Return>", self.send)
        self.root.bind("<Command-q>", lambda _event: self.close())
        self._theme_focus_at = 0
        self.root.bind("<FocusIn>", self.refresh_system_theme)

    def refresh_system_theme(self, _event=None):
        if self.theme.get() == "system" and time.monotonic() - self._theme_focus_at > 1:
            self._theme_focus_at = time.monotonic()
            self._apply_theme(save=False)

    def _button(self, parent, text, command, width=64, primary=False):
        button = QuietButton(parent, text, command, self.small_font, width, primary)
        self.buttons.append(button)
        return button

    def _menu(self, parent, variable, choices, callback, width):
        labels = dict(choices)
        button = self._button(parent, labels[variable.get()] + "  ˅", lambda: show(), width)
        menu = tk.Menu(button, tearoff=False)
        for value, label in choices:
            menu.add_radiobutton(label=label, variable=variable, value=value, command=callback)
        def show():
            try:
                menu.tk_popup(button.winfo_rootx(), button.winfo_rooty()+button.winfo_height())
            finally:
                menu.grab_release()
        variable.trace_add("write", lambda *_: button.configure(text=labels[variable.get()] + "  ˅"))
        return button

    def _build(self):
        self.buttons = []
        header = tk.Frame(self.root)
        header.pack(fill="x", padx=20, pady=(16, 8))
        tk.Label(header, text="See Now", font=(self.family, 16, "bold")).pack(side="left")
        self.collapse = self._button(header, "收起", self.toggle_collapse, 40)
        self.collapse.pack(side="right")
        self.subtitle = tk.Label(self.root, text="一起看，随时聊", anchor="w", font=self.small_font)
        self.subtitle.pack(fill="x", padx=20, pady=(0, 12))
        self.controls = tk.Frame(self.root)
        self.controls.pack(fill="x", padx=20, pady=(0, 12))
        source_row = tk.Frame(self.controls)
        source_row.pack(fill="x", pady=(0, 4))
        self._button(source_row, "选择视频", self.choose_file, 64).pack(side="left")
        self.source_label = tk.Label(source_row, text="未选择来源", anchor="e", font=self.small_font)
        self.source_label.pack(side="right", fill="x", expand=True, padx=(12, 0))
        transport = tk.Frame(self.controls)
        transport.pack(fill="x", pady=(0, 4))
        self.back = self._button(transport, "−10 秒", lambda: self.jump(-10), 56)
        self.back.pack(side="left")
        self.play = self._button(transport, "暂停", self.toggle_play, 64, primary=True)
        self.play.pack(side="left", padx=8)
        self.forward = self._button(transport, "+10 秒", lambda: self.jump(10), 56)
        self.forward.pack(side="left")
        self.stop = self._button(transport, "停止", lambda: self.command("stop"), 40)
        self.stop.pack(side="right")
        self.progress = Timeline(self.controls)
        self.progress.pack(fill="x")
        self.progress.bind("<ButtonPress-1>", lambda _e: setattr(self, "_seeking", self.progress.enabled), add="+")
        self.progress.bind("<ButtonRelease-1>", self.seek)
        self.progress.bind("<<Seek>>", lambda _e: self.command("seek", position=self.progress.get()))
        self.time_label = tk.Label(self.controls, text="00:00 / --:--", font=self.small_font, anchor="w")
        self.time_label.pack(fill="x", pady=(0, 8))
        seek_row = tk.Frame(self.controls)
        seek_row.pack(fill="x", pady=(0, 4))
        tk.Label(seek_row, text="跳转到", font=self.small_font).pack(side="left")
        self.seek_value = tk.StringVar()
        self.seek_entry = tk.Entry(seek_row, textvariable=self.seek_value, width=8, font=self.small_font,
                                  relief="flat", bd=0, highlightthickness=0)
        self.seek_entry.pack(side="left", padx=8, ipady=4)
        self.seek_entry.bind("<Return>", self.seek_time)
        self.seek_button = self._button(seek_row, "跳转", self.seek_time, 40)
        self.seek_button.pack(side="left")
        tk.Label(seek_row, text="秒数或 分:秒", font=self.small_font).pack(side="right")
        settings = tk.Frame(self.controls)
        settings.pack(fill="x", pady=(4, 0))
        self.quality_menu = self._menu(settings, self.quality,
            [("low", "轻量"), ("standard", "标准"), ("high", "高清"), ("ultra", "超清")],
            lambda: self.command("configure", quality=self.quality.get()), 60)
        self.quality_menu.pack(side="left")
        self.pace_menu = self._menu(settings, self.pace,
            [("calm", "慢节奏"), ("normal", "标准节奏"), ("dense", "快节奏")],
            lambda: self.command("configure", pace=self.pace.get()), 84)
        self.pace_menu.pack(side="left", padx=4)
        self.theme_menu = self._menu(settings, self.theme,
            [("system", "跟随系统"), ("light", "浅色"), ("dark", "深色")], self._apply_theme, 84)
        self.theme_menu.pack(side="left")
        self.pin = self._button(settings, "置顶 ✓" if self.pinned.get() else "置顶", self.switch_pin, 56)
        self.pin.pack(side="right")
        self.content = tk.Frame(self.root, highlightthickness=0)
        self.history = tk.Text(self.content, wrap="char", relief="flat", borderwidth=0,
                               font=self.body_font, padx=0, pady=8, spacing1=2, spacing3=8,
                               insertwidth=0, cursor="arrow", state="disabled", height=4, width=1,
                               highlightthickness=0, exportselection=False)
        self.history.pack(fill="both", expand=True)
        self.history.tag_configure("author", font=self.small_font, spacing1=16, spacing3=4)
        self.history.tag_configure("assistant", spacing3=16)
        self.history.tag_configure("user", spacing3=16)
        self.history.tag_configure("meta", font=self.small_font, spacing3=12)
        self.history.tag_configure("empty_title", font=(self.family, 16), spacing1=16, spacing3=8)
        self.history.tag_configure("empty", font=self.body_font, spacing3=16)
        self.history.bind("<Command-c>", self.copy_selection)
        self.footer = tk.Frame(self.root)
        self.footer.pack(side="bottom", fill="x", padx=20, pady=(0, 12))
        self.input_frame = tk.Canvas(self.footer, height=44, highlightthickness=0, bd=0)
        self.input_frame.pack(fill="x")
        self.input_frame.bind("<Configure>", self._draw_input)
        self.value = tk.StringVar()
        self.entry = tk.Entry(self.input_frame, textvariable=self.value, font=self.body_font,
                               relief="flat", bd=0, highlightthickness=0)
        self.entry.pack(side="left", fill="x", expand=True, padx=(12, 8), pady=12)
        self.entry.bind("<Return>", self.send)
        self.entry.bind("<FocusIn>", self._draw_input)
        self.entry.bind("<FocusOut>", self._draw_input)
        self.send_button = self._button(self.input_frame, "发送", self.send, 48, primary=True)
        self.send_button.configure(state="disabled")
        self.send_button.pack(side="right", padx=(0, 8), pady=8)
        self.value.trace_add("write", self._input_changed)
        self.help = tk.Label(self.footer, text="随时提问，回车发送 · 关闭窗口结束观看", font=(self.family, 10), anchor="w")
        self.help.pack(fill="x", pady=(8, 0))
        self.content.pack(fill="both", expand=True, padx=20, pady=(0, 12))

    def _draw_input(self, _event=None):
        if not hasattr(self, "colors"):
            return
        self.input_frame.delete("outline")
        color = self.colors["accent"] if self.root.focus_get() == self.entry else self.colors["border"]
        item = rounded(self.input_frame, 1, 1, self.input_frame.winfo_width()-2,
                       self.input_frame.winfo_height()-2, 12,
                       fill=self.colors["surface"], outline=color, width=1, tags="outline")
        self.input_frame.tag_lower(item)

    def switch_pin(self):
        self.pinned.set(not self.pinned.get())
        self.pin.configure(text="置顶 ✓" if self.pinned.get() else "置顶")
        self.toggle_pin()

    def _input_changed(self, *_args):
        self.send_button.configure(state="normal" if self.value.get().strip() else "disabled")

    def _load_history(self):
        try:
            with open(self.chat_file, "rb") as stream:
                size = os.fstat(stream.fileno()).st_size
                stream.seek(max(0, size - 96 * 1024))
                chunk = stream.read()
            self._offset = size
            lines = chunk.splitlines()
            if size > 96 * 1024:
                lines = lines[1:]
            for line in lines[-40:]:
                try:
                    self.render(json.loads(line))
                except (ValueError, UnicodeError):
                    continue
        except OSError:
            pass
        if self._count == 0:
            self.history.configure(state="normal")
            self.history.insert("end", "把想法留在这里\n", "empty_title")
            self.history.insert("end", "有疑问就问一句，或告诉 AI 你想关注的细节。\n", "empty")
            self.history.configure(state="disabled")
        self.history.see("end")

    def render(self, entry):
        text = str(entry.get("text") or "").strip()
        if not text:
            return
        at_bottom = self.history.yview()[1] >= 0.97
        self.history.configure(state="normal")
        if self._count == 0:
            self.history.delete("1.0", "end")
        role = entry.get("role", "assistant")
        if role == "meta":
            if text.startswith("[看屏幕] 叫醒失败"):
                text = "自动提醒暂未连接，仍可继续取图。"
            self.history.insert("end", text + "\n", "meta")
        else:
            label = "你" if role == "user" else "See Now"
            stamp = entry.get("at")
            if isinstance(stamp, (int, float)):
                label += "  ·  " + time.strftime("%H:%M", time.localtime(stamp / 1000))
            self.history.insert("end", label + "\n", "author")
            self.history.insert("end", text + "\n", "user" if role == "user" else "assistant")
        self._count += 1
        # 窗口保留近期对话，完整记录仍在原聊天文件。
        if int(self.history.index("end-1c").split(".")[0]) > 1200:
            self.history.delete("1.0", "200.0")
        self.history.configure(state="disabled")
        if at_bottom:
            self.history.see("end")

    def send(self, _event=None):
        text = self.value.get().strip()
        if not text:
            return "break"
        try:
            self.append_user(text)
        except OSError as error:
            self.subtitle.configure(text=f"发送失败：{error}", fg="#bd3d3d")
            return "break"
        self.value.set("")
        self.poll(schedule=False)
        self.entry.focus_set()
        return "break"

    def copy_selection(self, _event=None):
        try:
            text = self.history.get("sel.first", "sel.last")
            self.root.clipboard_clear()
            self.root.clipboard_append(text)
        except tk.TclError:
            pass
        return "break"

    def poll(self, schedule=True):
        if self._see_closed:
            return
        try:
            size = os.path.getsize(self.chat_file)
            if size < self._offset:
                self._offset, self._carry = 0, b""
            with open(self.chat_file, "rb") as stream:
                stream.seek(self._offset)
                chunk = stream.read()
            self._offset += len(chunk)
            lines = (self._carry + chunk).split(b"\n")
            self._carry = lines.pop()
            for line in lines:
                try:
                    self.render(json.loads(line))
                except (ValueError, UnicodeError):
                    continue
        except OSError:
            pass
        if schedule:
            self._poll_job = self.root.after(200, self.poll)

    def choose_file(self):
        path = filedialog.askopenfilename(parent=self.root, title="选择要一起看的视频",
                                          filetypes=[("视频文件", "*.mp4 *.mov *.mkv *.webm *.m4v *.avi"), ("所有文件", "*")])
        if path:
            self.command("watch", source="file", path=path)

    def toggle_play(self):
        state = self.state.get("playback", {}).get("state")
        self.command("resume" if state == "paused" else "pause")

    def jump(self, seconds):
        playback = self.state.get("playback", {})
        position = max(0, self._number(playback.get("positionSec")) + seconds)
        duration = playback.get("durationSec")
        if isinstance(duration, (int, float)) and duration > 0:
            position = min(position, duration)
        self.command("seek", position=position)

    def seek(self, _event=None):
        if self._seeking and self.state.get("playback", {}).get("canSeek"):
            self.command("seek", position=float(self.progress.get()))
        self._seeking = False

    def seek_time(self, _event=None):
        try:
            parts = self.seek_value.get().strip().split(":")
            if not 1 <= len(parts) <= 3:
                raise ValueError()
            position = 0
            for part in parts:
                value = float(part)
                if not math.isfinite(value) or value < 0:
                    raise ValueError()
                position = position * 60 + value
            self.command("seek", position=position)
        except ValueError:
            self.subtitle.configure(text="请输入秒数或 分:秒，例如 90 或 1:30")
        return "break"

    @staticmethod
    def _number(value):
        return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else 0.0

    @staticmethod
    def _clock(value):
        seconds = max(0, int(MacFloatChat._number(value)))
        hours, seconds = divmod(seconds, 3600)
        minutes, seconds = divmod(seconds, 60)
        return f"{hours}:{minutes:02}:{seconds:02}" if hours else f"{minutes:02}:{seconds:02}"

    def apply_state(self, state):
        """只显示宿主确认后的播放、采集和错误状态，不乐观推进播放时钟。"""
        self.state = state
        playback = state.get("playback") or {}
        source = state.get("source") or state.get("lastSource") or {}
        status = playback.get("state", "idle")
        labels = {"idle": "等待开始", "playing": "正在读取视频", "paused": "已暂停", "ended": "播放完毕",
                  "stopped": "已停止", "unavailable": "等待选择视频或开始看屏幕", "failed": "播放失败", "seeking": "定位中", "running": "正在播放"}
        if source.get("kind") != "file" and state.get("running"):
            label = "正在看屏幕"
        else:
            label = labels.get(status, "等待开始")
        self.subtitle.configure(text=str(state.get("lastError") or label)[:160])
        self.source_label.configure(text=os.path.basename(source.get("path", "")) or ("屏幕" if source.get("kind") == "screen" else "未选择来源"))
        can_seek = bool(playback.get("canSeek")) and source.get("kind") == "file"
        active = status in ("playing", "paused", "running")
        self.play.configure(text="继续" if status == "paused" else "暂停", state="normal" if active else "disabled")
        self.stop.configure(state="normal" if active or state.get("running") else "disabled")
        self.seek_button.configure(state="normal" if can_seek else "disabled")
        self.seek_entry.configure(state="normal" if can_seek else "disabled")
        for button in (self.back, self.forward):
            button.configure(state="normal" if can_seek else "disabled")
        duration = self._number(playback.get("durationSec"))
        position = self._number(playback.get("positionSec"))
        self.progress.configure(to=max(1, duration), state="normal" if can_seek and duration > 0 else "disabled")
        if not self._seeking:
            self.progress.set(position)
        target = playback.get("requestedPositionSec")
        note = f"待定位 {self._clock(target)}" if target is not None else "AI 已读取进度"
        self.time_label.configure(text=f"{self._clock(position)} / {self._clock(duration) if duration > 0 else '--:--'}  ·  {note}")
        if state.get("quality") in ("low", "standard", "high", "ultra"):
            self.quality.set(state["quality"])
        if state.get("pace") in ("calm", "normal", "dense"):
            self.pace.set(state["pace"])

    def toggle_pin(self):
        self.root.attributes("-topmost", self.pinned.get())
        self.write_config({"topmost": self.pinned.get()})

    def _apply_theme(self, save=True):
        dark = self.theme.get() == "dark"
        if self.theme.get() == "system":
            try:
                dark = bool(self.root.tk.call("tk::unsupported::MacWindowStyle", "isdark", self.root._w))
            except tk.TclError:
                dark = False
        background, surface = ("#202124", "#292a2e") if dark else ("#f7f7f8", "#ffffff")
        text, muted = ("#ededf0", "#97999f") if dark else ("#27272b", "#777980")
        self.colors = {"background": background, "surface": surface, "text": text, "muted": muted,
                       "border": "#3c3d42" if dark else "#dedee3", "accent": "#91b7e7" if dark else "#3566a4",
                       "primary": "#e2e3e7" if dark else "#303137", "on_primary": "#232429" if dark else "#ffffff"}
        def paint(widget):
            if isinstance(widget, (tk.Frame, tk.Label)):
                widget.configure(bg=background)
                if isinstance(widget, tk.Label):
                    widget.configure(fg=muted)
            for child in widget.winfo_children():
                paint(child)
        self.root.configure(bg=background)
        paint(self.root)
        header = self.collapse.master
        header.winfo_children()[0].configure(fg=text)
        self.history.configure(bg=background, fg=text, selectbackground="#3b506b" if dark else "#d5e3f5")
        for tag in ("author", "meta", "empty"):
            self.history.tag_configure(tag, foreground=muted)
        self.history.tag_configure("empty_title", foreground=text)
        self.history.tag_configure("assistant", foreground=text)
        self.history.tag_configure("user", foreground=self.colors["accent"])
        self.entry.configure(bg=surface, fg=text, insertbackground=text)
        self.seek_entry.configure(bg=background, fg=text, insertbackground=text,
                                  disabledbackground=background, disabledforeground=muted)
        self.input_frame.configure(bg=background)
        for button in self.buttons:
            button.colors = dict(self.colors)
            if button == self.send_button:
                button.colors["background"] = surface
            button.draw()
        self.progress.background, self.progress.track, self.progress.ink = background, self.colors["border"], self.colors["accent"]
        self.progress.draw()
        self._draw_input()
        if save:
            self.write_config({"theme": self.theme.get()})

    def toggle_collapse(self):
        self._collapsed = not self._collapsed
        if self._collapsed:
            self._expanded_geometry = self.root.geometry()
            self.controls.pack_forget()
            self.content.pack_forget()
            self.footer.pack_forget()
            self.root.minsize(360, 112)
            self.root.geometry(f"{self.root.winfo_width()}x112")
            self.collapse.configure(text="展开")
        else:
            if os.environ.get("DSH_SEE_WINDOW_STANDALONE") != "1":
                self.controls.pack(fill="x", padx=20, pady=(0, 12), after=self.subtitle)
            self.content.pack(fill="both", expand=True, padx=20, pady=(0, 12))
            self.footer.pack(side="bottom", fill="x", padx=20, pady=(0, 12), before=self.content)
            self.root.minsize(400, 480)
            self.root.geometry(self._expanded_geometry)
            self.collapse.configure(text="收起")

    def _stop_mic(self):
        """保持旧窗口退出契约；本窗口没有麦克风来源。"""

    def close(self, reason="user"):
        if self._see_closed:
            return
        self._see_closed = True
        self.notify("closed", reason)
        if self._poll_job is not None:
            self.root.after_cancel(self._poll_job)
        self.write_config({"geometry": self._expanded_geometry if self._collapsed else self.root.geometry()})
        self.root.destroy()
