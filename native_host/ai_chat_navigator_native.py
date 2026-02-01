#!/usr/bin/env python3
# Native Messaging Host for "AI Chat Navigator"
# - Bridges Chrome Extension <-> local filesystem (read/write a JSON file)
#
# Protocol: Chrome native messaging (length-prefixed JSON over stdin/stdout)

import json
import os
import sys
import struct
import tempfile

def _read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len:
        return None
    msg_len = struct.unpack('<I', raw_len)[0]
    if msg_len <= 0 or msg_len > 50 * 1024 * 1024:
        return None
    data = sys.stdin.buffer.read(msg_len)
    if not data:
        return None
    try:
        return json.loads(data.decode('utf-8'))
    except Exception:
        return None

def _send_message(obj):
    try:
        out = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    except Exception as e:
        out = json.dumps({"ok": False, "error": f"json_encode_failed: {e}"}).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(out)))
    sys.stdout.buffer.write(out)
    sys.stdout.buffer.flush()

def _err(msg, code=None):
    o = {"ok": False, "error": msg}
    if code:
        o["code"] = code
    return o

def _safe_abs_path(p):
    if not isinstance(p, str):
        return None
    p = p.strip()
    if not p:
        return None
    # Expand ~ and env vars
    p = os.path.expandvars(os.path.expanduser(p))
    # Make absolute
    p = os.path.abspath(p)
    return p

def _read_file(path):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return {"ok": True, "data": f.read()}
    except FileNotFoundError:
        return _err("file_not_found", code="ENOENT")
    except Exception as e:
        return _err(f"read_failed: {e}")

def _atomic_write(path, data):
    try:
        parent = os.path.dirname(path)
        if parent and not os.path.exists(parent):
            os.makedirs(parent, exist_ok=True)

        # Write to temp then rename
        fd, tmp_path = tempfile.mkstemp(prefix=".gnp_tmp_", dir=parent or None, text=True)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.write(data if isinstance(data, str) else str(data))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, path)
        finally:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass

        return {"ok": True}
    except Exception as e:
        return _err(f"write_failed: {e}")

def handle(msg):
    if not isinstance(msg, dict):
        return _err("invalid_message")

    op = msg.get("op")
    if op == "ping":
        return {"ok": True, "host": "ai_chat_navigator_native"}

    path = _safe_abs_path(msg.get("path"))
    if not path:
        return _err("invalid_path")

    # Minimal safety: only allow .json files (you can relax this if needed)
    if not path.lower().endswith(".json"):
        return _err("path_must_end_with_.json")

    if op == "read":
        return _read_file(path)

    if op == "write":
        data = msg.get("data", "")
        if data is None:
            data = ""
        # Ensure it's valid JSON (avoid writing garbage)
        try:
            json.loads(data if isinstance(data, str) else json.dumps(data))
        except Exception:
            # still allow writing raw text if user wants, but mark warning
            pass
        return _atomic_write(path, data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, indent=2))

    return _err("unknown_op")

def main():
    while True:
        msg = _read_message()
        if msg is None:
            break
        resp = handle(msg)
        _send_message(resp)

if __name__ == "__main__":
    main()
