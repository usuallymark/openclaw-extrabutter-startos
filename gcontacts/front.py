#!/usr/bin/env python3
"""The contacts service's front door: the MCP endpoint OpenClaw connects to.

Shared with the package's other services (agentsvc/frontdoor.py, copied
next to this file): no settings, no sign-in; tool calls go to the worker
(contactsservice.py) over a Unix socket only openclaw-contacts can open.

Started as root by the StartOS daemon "contacts-front"; it becomes
openclaw-contacts before listening.
"""

import sys

sys.path.insert(0, '/opt/openclaw-contacts')

import os  # noqa: E402

import frontdoor  # noqa: E402
import mcp  # noqa: E402

SOCKET = os.environ.get('CONTACTS_SOCKET') or '/data/.openclaw-contacts/state/worker.sock'
UNAVAILABLE = ('contacts service reloading or starting, try again shortly '
               '(if this lasts, the Contacts Service line in StartOS says why)')


def main():
    frontdoor.serve(
        label='contacts front', user='openclaw-contacts', sock_path=SOCKET,
        port=int(os.environ.get('CONTACTS_PORT') or 18807), server=mcp.SERVER,
        unavailable=UNAVAILABLE, starting_reason='the contacts side is starting or reloading')


if __name__ == '__main__':
    main()
