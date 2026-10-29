#!/usr/bin/env python3
"""The mail service's front door: the MCP endpoint OpenClaw connects to.

The front door itself is shared with the package's other services
(agentsvc/frontdoor.py, copied next to this file): it holds no settings and
no password, answers the handshake and the tool list itself, and passes
each tool call to the worker (mailservice.py) over a Unix socket that only
the openclaw-mail user can open. While the worker is away (reloading its
password), a call gets "mail service reloading, try again shortly" as an
ordinary tool error.

Started as root by the StartOS daemon "mail-front"; it becomes openclaw-mail
before listening.
"""

import sys

sys.path.insert(0, '/opt/openclaw-mail')

import os  # noqa: E402

import frontdoor  # noqa: E402
import mcp  # noqa: E402

SOCKET = os.environ.get('MAIL_SOCKET') or '/data/.openclaw-mail/state/worker.sock'
UNAVAILABLE = ('mail service reloading or starting, try again shortly '
               '(if this lasts, the Mail Service line in StartOS says why)')


def main():
    frontdoor.serve(
        label='mail front', user='openclaw-mail', sock_path=SOCKET,
        port=int(os.environ.get('MAIL_PORT') or 18805), server=mcp.SERVER,
        unavailable=UNAVAILABLE, starting_reason='the mailbox side is starting or reloading')


if __name__ == '__main__':
    main()
