#!/usr/bin/env python3
"""The calendar service's front door: the MCP endpoint OpenClaw connects to.

Shared with the package's other services (agentsvc/frontdoor.py, copied
next to this file): no settings, no sign-in; tool calls go to the worker
(calservice.py) over a Unix socket only openclaw-calendar can open.

Started as root by the StartOS daemon "calendar-front"; it becomes
openclaw-calendar before listening.
"""

import sys

sys.path.insert(0, '/opt/openclaw-calendar')

import os  # noqa: E402

import frontdoor  # noqa: E402
import mcp  # noqa: E402

SOCKET = os.environ.get('CALENDAR_SOCKET') or '/data/.openclaw-calendar/state/worker.sock'
UNAVAILABLE = ('calendar service reloading or starting, try again shortly '
               '(if this lasts, the Calendar Service line in StartOS says why)')


def main():
    frontdoor.serve(
        label='calendar front', user='openclaw-calendar', sock_path=SOCKET,
        port=int(os.environ.get('CALENDAR_PORT') or 18806), server=mcp.SERVER,
        unavailable=UNAVAILABLE, starting_reason='the calendar side is starting or reloading')


if __name__ == '__main__':
    main()
