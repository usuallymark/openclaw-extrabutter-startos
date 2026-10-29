#!/usr/bin/env python3
"""Make the Google sign-in for OpenClaw Extra Butter's calendar service.

Run once on a computer with a browser (your Mac), with the OAuth client
file of a "Desktop app" client from your own Google Cloud project:

    python3 google-signin.py ~/Downloads/client_secret_XXXX.json > calendar-signin.json

Your browser opens Google's sign-in page; sign in as the account the
assistant uses and allow access. The sign-in is printed as one line of
JSON (here saved to calendar-signin.json). Put it in Vaultwarden (item
"google-calendar", hidden field "token") or paste it into Configure
Calendar, then delete the file.

By default it asks only to read calendars (calendar.readonly) and for the
account's email address, so the sign-in cannot change anything.

Python 3.8 or later, standard library only. Nothing is sent anywhere but
Google; the browser comes back to this script on 127.0.0.1.
"""

import argparse
import base64
import hashlib
import json
import os
import secrets
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
TOKEN_URL = 'https://oauth2.googleapis.com/token'
PREFIX = 'https://www.googleapis.com/auth/'
DEFAULT_SCOPES = ['calendar.readonly']


def fail(msg):
    print(f'google-signin: {msg}', file=sys.stderr)
    sys.exit(1)


def load_client(path):
    try:
        with open(os.path.expanduser(path)) as f:
            d = json.load(f)
    except (OSError, ValueError) as e:
        fail(f'cannot read the OAuth client file {path}: {e}')
    c = d.get('installed') or d.get('web') or {}
    if 'web' in d:
        fail('this is a "Web application" client; create a "Desktop app" client instead '
             '(Google Cloud console → APIs & Services → Credentials → Create credentials → OAuth client ID)')
    if not c.get('client_id'):
        fail('the file has no client_id; download the JSON of a "Desktop app" OAuth client')
    return c['client_id'], c.get('client_secret') or ''


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('client_file', help='client_secret_….json of a Desktop app OAuth client')
    ap.add_argument('--scopes', default=','.join(DEFAULT_SCOPES),
                    help='comma-separated, without the https://www.googleapis.com/auth/ prefix (default: calendar.readonly)')
    ap.add_argument('--no-browser', action='store_true', help='print the address instead of opening the browser')
    ap.add_argument('--auth-url', default=AUTH_URL, help=argparse.SUPPRESS)
    ap.add_argument('--token-url', default=TOKEN_URL, help=argparse.SUPPRESS)
    a = ap.parse_args()

    client_id, client_secret = load_client(a.client_file)
    scopes = [s.strip() for s in a.scopes.split(',') if s.strip()]
    full = ['openid', 'email'] + [s if s.startswith('https://') else PREFIX + s for s in scopes]

    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b'=').decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    state = secrets.token_urlsafe(24)
    got = {}
    done = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if 'state' not in q and 'code' not in q and 'error' not in q:
                self.send_response(404)
                self.end_headers()
                return
            if q.get('state', [''])[0] != state:
                got['error'] = 'the answer did not match this sign-in (state); run the script again'
            elif 'error' in q:
                got['error'] = f'Google said: {q["error"][0]}'
            else:
                got['code'] = q.get('code', [''])[0]
            text = ('Signed in. You can close this tab and go back to the terminal.' if 'code' in got
                    else 'Sign-in failed: ' + got.get('error', '') + '. Go back to the terminal.')
            body = f'<!doctype html><meta charset="utf-8"><p style="font:16px sans-serif">{text}</p>'.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            done.set()

    srv = HTTPServer(('127.0.0.1', 0), Handler)
    redirect = f'http://127.0.0.1:{srv.server_address[1]}'
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    url = a.auth_url + '?' + urllib.parse.urlencode({
        'client_id': client_id, 'redirect_uri': redirect, 'response_type': 'code',
        'scope': ' '.join(full), 'access_type': 'offline', 'prompt': 'consent',
        'code_challenge': challenge, 'code_challenge_method': 'S256', 'state': state,
    })
    print('Asking Google for: ' + ', '.join(scopes) + ' (plus your email address).', file=sys.stderr)
    print('If the browser does not open, open this address yourself:\n' + url, file=sys.stderr)
    print('Google may warn that the app is not verified: it is your own app; choose Advanced → Go to … (unsafe).',
          file=sys.stderr)
    if not a.no_browser:
        webbrowser.open(url)
    if not done.wait(600):
        fail('no answer from the browser within 10 minutes')
    srv.shutdown()
    if 'code' not in got:
        fail(got.get('error') or 'no sign-in code came back')

    body = urllib.parse.urlencode({
        'grant_type': 'authorization_code', 'code': got['code'], 'redirect_uri': redirect,
        'client_id': client_id, 'client_secret': client_secret, 'code_verifier': verifier,
    }).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(a.token_url, body), timeout=30) as r:
            tok = json.loads(r.read())
    except urllib.error.HTTPError as e:
        fail(f'Google refused the sign-in code: HTTP {e.code} {e.read(500).decode("utf-8", "replace")}')
    except (urllib.error.URLError, OSError, ValueError) as e:
        fail(f'cannot reach Google: {e}')
    if not tok.get('refresh_token'):
        fail('Google gave no refresh token; remove the app under myaccount.google.com → Security → '
             'Third-party access, then run this again')

    account = ''
    idt = tok.get('id_token') or ''
    try:
        part = idt.split('.')[1]
        account = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4))).get('email') or ''
    except (IndexError, ValueError):
        pass
    granted = sorted(s[len(PREFIX):] if s.startswith(PREFIX) else s for s in str(tok.get('scope') or '').split())
    out = {
        'type': 'openclaw-google-signin', 'account': account,
        'client_id': client_id, 'client_secret': client_secret,
        'refresh_token': tok['refresh_token'], 'scopes': granted,
    }
    print(json.dumps(out, separators=(',', ':')))
    missing = [s for s in scopes if s not in granted]
    print(f'Signed in as {account or "(unknown)"}; allowed: {", ".join(granted) or "(not reported)"}.', file=sys.stderr)
    if missing:
        print('Warning: Google did not allow ' + ', '.join(missing) + ' (a box left unticked on the consent page?).',
              file=sys.stderr)


if __name__ == '__main__':
    main()
