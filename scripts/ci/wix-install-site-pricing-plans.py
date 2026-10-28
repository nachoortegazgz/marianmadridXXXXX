#!/usr/bin/env python3
"""Run the Wix CLI for Sites package installer in a bounded CI pseudo-terminal."""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

PACKAGE = "@wix/site-pricing-plans"
TIMEOUT_SECONDS = 180
EARLY_CONFIRM_SECONDS = 3


def stop_process_group(pid):
    """Terminate the CLI and descendants; do not leave a hung CI process."""
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            waited, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return
        if waited == pid:
            return
        time.sleep(0.1)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


def main():
    env = os.environ.copy()
    # The CLI uses CI markers to disable interactive prompts. Remove them only
    # from this child process; GitHub Actions remains a CI job.
    for marker in ("CI", "GITHUB_ACTIONS", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "RUN_ID"):
        env.pop(marker, None)
    env["TERM"] = "xterm-256color"
    env["FORCE_COLOR"] = "1"

    executable = os.path.abspath("./node_modules/.bin/wix")
    if not os.path.isfile(executable):
        sys.stderr.write("Local Wix CLI binary not found at node_modules/.bin/wix.\n")
        return 127

    pid, master = pty.fork()
    if pid == 0:
        os.execvpe(executable, [executable, "install", PACKAGE], env)

    # Provide a real-sized controlling terminal for CLI libraries using raw mode.
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
    output = ""
    deadline = time.monotonic() + TIMEOUT_SECONDS
    confirm_at = time.monotonic() + EARLY_CONFIRM_SECONDS
    sent_confirmation = False

    try:
        while True:
            waited, status = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                code = os.waitstatus_to_exitcode(status)
                if code != 0:
                    return code
                break

            now = time.monotonic()
            if now >= deadline:
                tail = output[-5000:] or "<Wix CLI emitted no output>"
                sys.stderr.write("\nLast Wix CLI installer output before timeout:\n" + tail + "\n")
                return 2

            # A single Enter accepts a default confirmation if the CLI prompts.
            # Sending it after a short fixed delay also works when a spinner keeps
            # producing output and prevents idle-time detection from firing.
            if not sent_confirmation and now >= confirm_at:
                os.write(master, b"\r")
                sent_confirmation = True

            readable, _, _ = select.select([master], [], [], 0.25)
            if not readable:
                continue
            try:
                data = os.read(master, 4096)
            except OSError as exc:
                if exc.errno == errno.EIO:
                    continue
                raise
            if not data:
                continue

            chunk = data.decode("utf-8", errors="replace")
            sys.stdout.write(chunk)
            sys.stdout.flush()
            output = (output + chunk)[-20000:]

            if "Raw mode is not supported" in output or "NonInteractiveTerminal" in output:
                sys.stderr.write("\nWix CLI rejected the controlling terminal.\n")
                return 2

        return 0
    finally:
        try:
            waited, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            waited = pid
        if waited == 0:
            stop_process_group(pid)
        os.close(master)


if __name__ == "__main__":
    raise SystemExit(main())
