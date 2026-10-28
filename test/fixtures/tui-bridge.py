"""Drive a real TUI with JSON {text: ...} records on stdin; stream its PTY output."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
status = None
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin], [], [], 0.1)
        if sys.stdin in ready:
            line = sys.stdin.readline()
            if not line:
                break
            os.write(master, json.loads(line)["text"].encode())
        if master in ready:
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
        child, value = os.waitpid(pid, os.WNOHANG)
        if child:
            status = value
            break
finally:
    if status is None:
        child, value = os.waitpid(pid, os.WNOHANG)
        if child:
            status = value
        else:
            os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
    os.close(master)
sys.exit(os.waitstatus_to_exitcode(status))
