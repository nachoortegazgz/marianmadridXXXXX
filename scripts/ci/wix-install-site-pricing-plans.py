#!/usr/bin/env python3
"""Run the Wix CLI package installer with a bounded pseudo-terminal for CI."""

import errno
import os
import pty
import re
import select
import signal
import sys
import time

PACKAGE = "@wix/site-pricing-plans"
TIMEOUT_SECONDS = 180


def main():
    pid, master = pty.fork()
    if pid == 0:
        os.execvp("npm", ["npm", "run", "wix", "install", PACKAGE])

    output = ""
    deadline = time.monotonic() + TIMEOUT_SECONDS
    sent_confirmation = False

    try:
        while True:
            waited, status = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                code = os.waitstatus_to_exitcode(status)
                if code != 0:
                    return code
                break

            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Wix CLI package installation exceeded {TIMEOUT_SECONDS} seconds."
                )

            readable, _, _ = select.select([master], [], [], 0.5)
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
            output = (output + chunk)[-16000:]

            if not sent_confirmation and re.search(
                r"(continue|proceed|install).{0,100}(\(Y/n\)|\(y/N\)|\[Y/n\]|\[y/N\])",
                output,
                re.IGNORECASE | re.DOTALL,
            ):
                os.write(master, b"\r")
                sent_confirmation = True

            if re.search(r"Raw mode is not supported|NonInteractiveTerminal", output):
                raise RuntimeError("Wix CLI rejected the installation terminal.")

        return 0
    except (TimeoutError, RuntimeError) as exc:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        sys.stderr.write(f"\n{exc}\n")
        return 2
    finally:
        os.close(master)


if __name__ == "__main__":
    raise SystemExit(main())
