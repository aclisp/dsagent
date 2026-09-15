#!/usr/bin/env python3
"""Paired fresh-process measurements, using only the Python standard library."""
import argparse
import errno
import json
import math
import os
import platform
import select
import shutil
import statistics
import subprocess
import tempfile
import time
from pathlib import Path


def measure(manifest, variant, mode, extension, node):
    with tempfile.TemporaryDirectory(prefix="dscode-startup-") as temporary:
        scratch = Path(temporary)
        home = scratch / "home"
        cwd = scratch / "workspace"
        home.mkdir()
        cwd.mkdir()
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(home),
            "DSCODE_HOME": str(home),
            "DSCODE_CREDENTIALS_STORE": "file",
            "DEEPSEEK_API_KEY": "benchmark-only-not-a-real-key",
            "PI_OFFLINE": "1",
            "PI_TELEMETRY": "0",
            "PI_SKIP_VERSION_CHECK": "1",
            "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8",
            "XDG_CACHE_HOME": str(scratch / "cache"),
            "JITI_CACHE_DIR": str(scratch / "jiti-cache"),
        }
        entry = Path(manifest[variant]) / ("dist" if variant == "baseline" else "") / ("benchmark.js" if mode == "tui" else "cli.js")
        args = [node, str(entry), "--no-session", "--no-approve"]
        if extension:
            fixture = scratch / "extension.ts"
            fixture.write_text('''
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ModelRuntime, InteractiveMode } from "@earendil-works/pi-coding-agent";
export default function (pi) {
  const value: string = "extension-loaded";
  if (Type.String().type !== "string" || !(new Text(value) instanceof Text)) throw new Error("Extension imports broken");
  if (!ModelRuntime[Symbol.for("ai.thinkany.dscode.credential-store-installed")]) throw new Error("Extension sees a different ModelRuntime");
  if (!InteractiveMode.prototype[Symbol.for("dscode.runtime-branding")]) throw new Error("Extension sees a different InteractiveMode");
  pi.registerCommand("bundle-probe", { description: value, handler: async () => {} });
  pi.on("session_start", () => { process.stderr.write("DSCODE_EXTENSION_READY\\n"); });
}
''')
            args += ["--extension", str(fixture)]
        master = slave = None
        if mode == "tui":
            import fcntl
            import pty
            import struct
            import termios
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
            env["PI_STARTUP_BENCHMARK"] = "1"
            stdin, stdout = slave, slave
        else:
            args += ["--mode", "rpc"]
            stdin, stdout = subprocess.PIPE, subprocess.PIPE
        started = time.perf_counter()
        child = subprocess.Popen(args, cwd=cwd, env=env, stdin=stdin, stdout=stdout, stderr=subprocess.PIPE)
        if slave is not None:
            os.close(slave)
        if mode == "rpc":
            child.stdin.write(b'{"id":"ready","type":"get_state"}\n')
            child.stdin.flush()
        output_fd = master if master is not None else child.stdout.fileno()
        error_fd = child.stderr.fileno()
        descriptors = [output_fd, error_fd]
        stderr = b""
        stdout_buffer = b""
        output_tail = b""
        ready = None
        response = None
        try:
            while descriptors:
                if time.perf_counter() - started > 25:
                    raise RuntimeError("Timed out before clean benchmark exit")
                readable, _, _ = select.select(descriptors, [], [], 0.1)
                for descriptor in readable:
                    try:
                        data = os.read(descriptor, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        data = b""
                    if not data:
                        descriptors.remove(descriptor)
                        continue
                    if descriptor == error_fd:
                        stderr += data
                        if mode == "tui" and ready is None and b"DSCODE_BENCHMARK_READY\n" in stderr:
                            ready = (time.perf_counter() - started) * 1000
                    else:
                        output_tail = (output_tail + data)[-8000:]
                        if mode == "rpc":
                            stdout_buffer += data
                            while b"\n" in stdout_buffer:
                                line, stdout_buffer = stdout_buffer.split(b"\n", 1)
                                message = json.loads(line)
                                if message.get("id") == "ready" and message.get("type") == "response":
                                    if not message.get("success"):
                                        raise RuntimeError(f"RPC get_state failed: {message}")
                                    response = message["data"]
                                    ready = (time.perf_counter() - started) * 1000
                                    child.stdin.close()
            code = child.wait(timeout=5)
            if code != 0 or ready is None:
                raise RuntimeError(f"Exit {code}; no valid readiness result")
            if extension and b"DSCODE_EXTENSION_READY\n" not in stderr:
                raise RuntimeError("Extension session_start did not complete")
            if b"Error:" in stderr or b"error:" in stderr:
                raise RuntimeError("Startup emitted an error")
            if response and (response.get("isStreaming") or response.get("sessionFile") or response.get("model", {}).get("provider") != "deepseek"):
                raise RuntimeError(f"Unexpected RPC state: {response}")
            return {"variant": variant, "mode": mode, "extension": extension, "readyMs": ready}
        except Exception as error:
            raise RuntimeError(f"{variant}/{mode}/extension={extension}: {error}\nstderr: {stderr.decode(errors='replace')[-4000:]}\nstdout: {output_tail.decode(errors='replace')[-2000:]}") from error
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            child.stderr.close()
            if master is not None:
                os.close(master)
            else:
                child.stdout.close()
                if not child.stdin.closed:
                    child.stdin.close()


def summary(values):
    ordered = sorted(values)
    return {"n": len(values), "medianMs": statistics.median(values), "p95Ms": ordered[math.ceil(len(values) * 0.95) - 1], "minMs": min(values), "maxMs": max(values)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Experiment directory printed by build.mjs")
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--mode", choices=["tui", "rpc", "both"], default="both")
    parser.add_argument("--extensions", choices=["none", "loaded", "both"], default="both")
    parser.add_argument("--node", default=shutil.which("node"))
    args = parser.parse_args()
    if args.runs < 1 or args.warmup < 0:
        parser.error("runs must be positive and warmup nonnegative")
    manifest = json.loads((args.output / "manifest.json").read_text())
    records = []
    summaries = []
    modes = ["tui", "rpc"] if args.mode == "both" else [args.mode]
    extensions = [False, True] if args.extensions == "both" else [args.extensions == "loaded"]
    for mode in modes:
        for extension in extensions:
            for index in range(args.warmup + args.runs):
                # Alternate order to reduce bias from scheduling, temperature,
                # and filesystem caches. Every observation starts a new process.
                order = ["baseline", "deep"] if index % 2 == 0 else ["deep", "baseline"]
                pair = []
                for variant in order:
                    record = measure(manifest, variant, mode, extension, args.node)
                    record.update({"pair": index, "warmup": index < args.warmup})
                    records.append(record)
                    pair.append(f"{variant}={record['readyMs']:.1f}ms")
                print(f"{mode} extension={extension} {'warmup' if index < args.warmup else 'measured'} {index + 1}: {', '.join(pair)}", flush=True)
            row = {"mode": mode, "extension": extension}
            for variant in ["baseline", "deep"]:
                row[variant] = summary([r["readyMs"] for r in records if r["mode"] == mode and r["extension"] == extension and r["variant"] == variant and not r["warmup"]])
            row["medianReductionPercent"] = 100 * (1 - row["deep"]["medianMs"] / row["baseline"]["medianMs"])
            row["speedup"] = row["baseline"]["medianMs"] / row["deep"]["medianMs"]
            summaries.append(row)
    result = {"platform": platform.platform(), "machine": platform.machine(), "node": subprocess.check_output([args.node, "--version"], text=True).strip(), "runs": args.runs, "warmup": args.warmup, "method": "parent spawn to InteractiveMode.init completion (TUI) or get_state response (RPC); fresh isolated home per run; offline; alternating order; filesystem caches not flushed", "summaries": summaries, "records": records}
    destination = args.output / f"benchmark-{time.time_ns()}.json"
    destination.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(summaries, indent=2))
    print(f"Saved {destination}")


if __name__ == "__main__":
    main()
