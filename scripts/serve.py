#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""局域网内启动划课网站，并提供共享数据接口（多设备同步）。

用法：
    python scripts/serve.py [端口]        默认 8000

- 静态文件：服务于「划课网站」目录
- 数据接口：GET /api/state 读取共享数据；POST /api/state 写入（body 为 {"updatedAt": "...", "state": {...}}）
- 数据文件：<划课网站>/data.json（所有设备共享这一份）
- 手机 / iPad 与电脑连同一 Wi-Fi，浏览器访问打印出的「手机访问」地址，即可读写同一份数据
"""
import functools
import http.server
import json
import os
import socket
import sys
import threading

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_FILE = os.path.join(ROOT, "data.json")
DATA_LOCK = threading.Lock()
MAX_BODY = 32 * 1024 * 1024  # 请求体上限 32MB


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def read_state():
    with DATA_LOCK:
        if not os.path.exists(DATA_FILE):
            return None
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None


def write_state(payload):
    with DATA_LOCK:
        tmp = DATA_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, DATA_FILE)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/state":
            st = read_state()
            self._send_json(st if isinstance(st, dict) else {"updatedAt": "", "state": None})
            return
        super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/state":
            self._send_json({"ok": False, "error": "not found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._send_json({"ok": False, "error": "bad length"}, 400)
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._send_json({"ok": False, "error": "invalid json"}, 400)
            return
        if not isinstance(payload, dict) or not isinstance(payload.get("state"), dict):
            self._send_json({"ok": False, "error": "bad payload"}, 400)
            return
        write_state({
            "updatedAt": payload.get("updatedAt") or "",
            "state": payload["state"],
        })
        self._send_json({"ok": True})


def main():
    os.chdir(ROOT)
    print("服务目录：", ROOT)
    print("数据文件：", DATA_FILE, "（所有设备共享这一份）")
    print("本机访问： http://127.0.0.1:%d/index.html" % PORT)
    print("手机访问： http://%s:%d/index.html   （手机/iPad 需与电脑连同一 Wi-Fi）" % (lan_ip(), PORT))
    print("停止服务： 在本窗口按 Ctrl+C")
    sys.stdout.flush()
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
