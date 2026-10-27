"""ConPTY counterpart of tui-bridge.py and standalone/test/run_pty.py.

Requires the acceptance runner's pinned pywinpty, never a user's CLI install.
"""
import glob
import json
import os
import queue
import select
import sys
import threading
import time

from winpty import Backend, PtyProcess

probe = sys.argv[1] == "--probe"
arguments = sys.argv[2:] if probe else sys.argv[1:]
# pywinpty's backend selection reads this override as well as the argument.
os.environ["PYWINPTY_BACKEND"] = str(Backend.ConPTY)
process = PtyProcess.spawn(arguments, env=dict(os.environ), dimensions=(40, 140), backend=Backend.ConPTY)
inputs = queue.Queue()


def read_input():
    try:
        for line in sys.stdin.buffer:
            inputs.put(json.loads(line.decode("utf-8"))["text"])
    except Exception as error:
        inputs.put(error)
    finally:
        inputs.put(None)


if not probe:
    threading.Thread(target=read_input, daemon=True).start()

deadline = time.monotonic() + (20 if probe else 180)
paste_at = time.monotonic() + 2
exit_at = None
sent_paste = False
sent_submit = False
sent_exit = False
transcript = ""
status = None
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([process.fileobj], [], [], 0.1)
        if ready:
            try:
                data = process.read(65536)
            except EOFError:
                break
            sys.stdout.buffer.write(data.encode("utf-8"))
            sys.stdout.buffer.flush()
            transcript += data
        elif not process.isalive():
            break
        if not probe:
            while not inputs.empty():
                text = inputs.get_nowait()
                if isinstance(text, Exception):
                    raise text
                if text is None:
                    # The caller closed its side of the bridge.
                    deadline = 0
                    break
                process.write(text)
        else:
            if os.getenv("DSCODE_TEST_TUI_PASTE"):
                if not sent_paste and time.monotonic() >= paste_at:
                    process.write("describe \x16")
                    sent_paste = True
                if sent_paste and not sent_submit and glob.glob(os.path.join(os.environ["TMPDIR"], "pi-clipboard-*.png")):
                    process.write("\r")
                    sent_submit = True
            if os.getenv("DSCODE_TEST_TUI_DIALOG") and exit_at is None and "standalone ok" in transcript:
                exit_at = time.monotonic() + 0.3
            if exit_at is not None and not sent_exit and time.monotonic() >= exit_at:
                process.write("\x04")
                sent_exit = True
    if not process.isalive():
        status = process.exitstatus
finally:
    if process.isalive():
        process.terminate(force=True)
    process.close(force=True)
sys.exit(status if status is not None else 1)
