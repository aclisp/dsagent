"""Allocate a real PTY for the offline standalone startup probe (stdlib only)."""
import errno
import fcntl
import glob
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
deadline = time.monotonic() + 15
status = None
transcript = b""
sent_exit = False
sent_paste = False
sent_submit = False
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
            transcript += data
        if os.getenv("DSCODE_TEST_TUI_PASTE"):
            if not sent_paste and time.monotonic() > deadline - 13:
                os.write(master, b"describe \x16")
                sent_paste = True
            if sent_paste and not sent_submit and glob.glob(os.path.join(os.environ["TMPDIR"], "pi-clipboard-*.png")):
                time.sleep(0.3)
                os.write(master, b"\r")
                sent_submit = True
        if os.getenv("DSCODE_TEST_TUI_DIALOG") and not sent_exit and b"standalone ok" in transcript:
            time.sleep(0.3)
            os.write(master, b"\x04")
            sent_exit = True
        child, value = os.waitpid(pid, os.WNOHANG)
        if child:
            status = value
            break
    if status is None:
        child, value = os.waitpid(pid, os.WNOHANG)
        if child:
            status = value
        else:
            os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
finally:
    os.close(master)
sys.exit(os.waitstatus_to_exitcode(status))
