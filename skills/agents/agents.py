#!/usr/bin/env python3
"""Create, change and remove OpenClaw agents (agents.entries) safely.

The same rules as the StartOS action "Configure Agents": both write
OpenClaw's own config (openclaw.json `agents.entries`) through OpenClaw's
validated writer (`openclaw config patch`), so whatever is created here shows
up in that action and the other way round.

    python3 /opt/skills/agents/agents.py list [--json]
    python3 /opt/skills/agents/agents.py show ID
    python3 /opt/skills/agents/agents.py models [--json]
    python3 /opt/skills/agents/agents.py create ID --model REF [options]
    python3 /opt/skills/agents/agents.py update ID [options]
    python3 /opt/skills/agents/agents.py delete ID

Options for create/update:
    --name TEXT              display name
    --model REF              provider/model from `models`; "default" = the main model
    --profile P              minimal | messaging   (coding/full: Configure Agents only)
    --extra-tools a,b        tools added on top of the profile ("" clears)
    --blocked-tools a,b      tools always off ("" clears; gateway and cron stay blocked)
    --skills a,b | all | none
    --can-spawn a,b          other agents this agent may spawn ("" clears)
    --main-can-spawn yes|no  whether the main agent may spawn it (create: yes)
    --workspace PATH         folder with its AGENTS.md (create: workspace/workspaces/ID)
    --dry-run                validate and show the change, write nothing

Exit status 0 ok, 1 refused or failed.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

STATE = os.environ.get('OPENCLAW_STATE_DIR') or '/data/.openclaw'
DATA = os.path.dirname(STATE)
CONFIG = f'{STATE}/openclaw.json'
WORKSPACE_ROOT = f'{STATE}/workspace'
AGENTS_DIR = f'{WORKSPACE_ROOT}/workspaces'
CATALOG_CACHE = f'{DATA}/.startos/model-catalog.json'
OLLAMA_SERVER_ID = 'ollama-server'
MAIN = 'main'
ID_RE = re.compile(r'^[a-z][a-z0-9-]{0,31}$')

CLOUD_ENV = {
    'anthropic': 'ANTHROPIC_API_KEY',
    'openai': 'OPENAI_API_KEY',
    'google': 'GEMINI_API_KEY',
    'xai': 'XAI_API_KEY',
}
PROFILES = ('minimal', 'messaging', 'coding', 'full')
# What only a person may switch on, in Configure Agents. The agent's requests for
# these are refused with a pointer there.
SAFE_PROFILES = ('minimal', 'messaging')
POWERFUL_TOOLS = {
    '*', 'exec', 'bash', 'process', 'code_execution', 'gateway', 'cron',
    'nodes', 'computer', 'elevated', 'message',
    'group:runtime', 'group:automation', 'group:nodes', 'group:openclaw',
    'group:plugins', 'group:messaging',
}
ALWAYS_BLOCKED = ('gateway', 'cron')
# Models the provider offers but the bundled OpenClaw predates and cannot
# drive (requests fail). Keep in sync with startos/modelCatalog.ts
# UNSUPPORTED. Empty since OpenClaw 2026.9.8 (Opus/Sonnet 5.5, GPT-6 work).
UNSUPPORTED = {}


def unsupported(provider, mid):
    rx = UNSUPPORTED.get(provider)
    return bool(rx and rx.match(mid))

FIELDS = ('name', 'model', 'profile', 'extraTools', 'blockedTools', 'skills',
          'canSpawn', 'mainCanSpawn', 'workspace')


class AgentError(RuntimeError):
    pass


# ── reading ───────────────────────────────────────────────────────────────

def read_config():
    try:
        with open(CONFIG) as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        raise AgentError(f'cannot read {CONFIG}: {e}') from None


def entries(cfg):
    return ((cfg.get('agents') or {}).get('entries') or {})


def model_ref(entry):
    m = entry.get('model')
    if isinstance(m, dict):
        return m.get('primary') or ''
    return m or ''


def allow_list(entry):
    return list(((entry.get('subagents') or {}).get('allowAgents')) or [])


def main_spawns(cfg, agent_id):
    allow = allow_list(entries(cfg).get(MAIN) or {})
    return '*' in allow or agent_id in allow


def describe(cfg, agent_id):
    """The form view of one agent (same fields as Configure Agents)."""
    e = entries(cfg).get(agent_id)
    if e is None:
        raise AgentError(f'no agent "{agent_id}" (see: agents.py list)')
    tools = e.get('tools') or {}
    skills = e.get('skills')
    return {
        'id': agent_id,
        'name': e.get('name') or '',
        'model': model_ref(e) or 'default',
        'profile': tools.get('profile') or 'inherit',
        'extraTools': list(tools.get('alsoAllow') or tools.get('allow') or []),
        'blockedTools': list(tools.get('deny') or []),
        'skills': 'all' if skills is None else list(skills),
        'canSpawn': allow_list(e),
        'mainCanSpawn': main_spawns(cfg, agent_id) if agent_id != MAIN else None,
        'workspace': e.get('workspace') or '',
    }


def _gateway_env(name):
    """A variable from our environment, else from the gateway process."""
    if os.environ.get(name):
        return os.environ[name]
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            with open(f'/proc/{pid}/environ', 'rb') as f:
                for item in f.read().split(b'\0'):
                    k, _, v = item.partition(b'=')
                    if k == name.encode() and v:
                        return v.decode()
        except OSError:
            continue
    return ''


# ── models ────────────────────────────────────────────────────────────────

def _post(url, body, timeout=8):
    req = urllib.request.Request(url, json.dumps(body).encode(),
                                 {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b'{}')


def _get(url, timeout=8):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read() or b'{}')


def ollama_server(cfg):
    p = ((cfg.get('models') or {}).get('providers') or {}).get(OLLAMA_SERVER_ID)
    return p if isinstance(p, dict) else None


def local_models(base):
    """[(id, info)] of the Ollama server's models; raises when unreachable."""
    base = base.rstrip('/')
    try:
        names = [m.get('name') or m.get('model') for m in _get(f'{base}/api/tags').get('models', [])]
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise AgentError(f'Ollama server {base} unreachable: {getattr(e, "reason", e)}') from None
    out = []
    for n in filter(None, names):
        try:
            show = _post(f'{base}/api/show', {'model': n})
        except (urllib.error.URLError, OSError, ValueError):
            show = {}
        caps = [str(c) for c in show.get('capabilities') or []]
        info = show.get('model_info') or {}
        arch = info.get('general.architecture', '')
        ctx = info.get(f'{arch}.context_length')
        out.append((n, {
            'tools': 'tools' in caps,
            'embedOnly': 'embedding' in caps and 'completion' not in caps,
            'vision': 'vision' in caps,
            'thinking': 'thinking' in caps,
            'contextWindow': ctx if isinstance(ctx, int) and ctx > 0 else None,
        }))
    return out


def local_entry(mid, info):
    e = {'id': mid, 'name': mid, 'input': ['text', 'image'] if info.get('vision') else ['text']}
    if info.get('thinking'):
        e['reasoning'] = True
    if info.get('contextWindow'):
        e['contextWindow'] = info['contextWindow']
        e['contextTokens'] = min(info['contextWindow'], 32768)
    return e


def model_choices(cfg):
    """[(ref, label)] an agent may be given right now."""
    out = []
    try:
        with open(CATALOG_CACHE) as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    for p, env in CLOUD_ENV.items():
        if not _gateway_env(env):
            continue
        for mid, label in (cache.get(p) or {}).get('chat', []):
            if not unsupported(p, mid):
                out.append((f'{p}/{mid}', label))
        # The main agent's current model is always a valid choice.
    dm = ((cfg.get('agents') or {}).get('defaults') or {}).get('model') or {}
    for ref in [dm.get('primary'), *(dm.get('fallbacks') or [])]:
        if ref and ref not in [r for r, _ in out]:
            out.append((ref, f'{ref} (main agent)'))
    srv = ollama_server(cfg)
    if srv and srv.get('baseUrl'):
        try:
            for mid, info in local_models(srv['baseUrl']):
                if info['tools'] and not info['embedOnly']:
                    out.append((f'{OLLAMA_SERVER_ID}/{mid}', f'Local · {mid}'))
        except AgentError as e:
            for m in srv.get('models') or []:
                out.append((f'{OLLAMA_SERVER_ID}/{m["id"]}', f'Local · {m["id"]} (server offline)'))
            print(f'note: {e}', file=sys.stderr)
    return out


def check_model(cfg, ref, ui, patch):
    """Validate a model ref; for a local model, list it in the provider entry."""
    if ref in ('', 'default'):
        return None
    if '/' not in ref:
        raise AgentError(f'model must be provider/model, e.g. anthropic/claude-sonnet-4-6 (see: agents.py models)')
    provider, mid = ref.split('/', 1)
    providers = (cfg.get('models') or {}).get('providers') or {}
    if provider == OLLAMA_SERVER_ID:
        srv = ollama_server(cfg)
        if not srv:
            raise AgentError('Local models are off. Turn on "Local Chat Models for Agents" in Configure AI Provider first.')
        pending = (((patch.get('models') or {}).get('providers') or {}).get(OLLAMA_SERVER_ID) or {}).get('models')
        listed = [m.get('id') for m in (pending or srv.get('models') or [])]
        if mid in listed:
            return ref
        found = dict(local_models(srv.get('baseUrl', '')))
        info = found.get(mid)
        if info is None:
            raise AgentError(f'"{mid}" is not on the Ollama server (pull it there first; see: agents.py models)')
        if not info['tools'] or info['embedOnly']:
            raise AgentError(f'"{mid}" cannot call tools, so it cannot run an agent. Pick a tool-capable model.')
        slot = patch.setdefault('models', {}).setdefault('providers', {}).setdefault(
            OLLAMA_SERVER_ID, {'models': list(srv.get('models') or [])})
        if mid not in [m.get('id') for m in slot['models']]:
            slot['models'].append(local_entry(mid, info))
        return ref
    if provider in CLOUD_ENV:
        if unsupported(provider, mid):
            raise AgentError(f'{ref} is not supported by this OpenClaw version yet (its requests are rejected); '
                             f'pick another model (see: agents.py models)')
        if not ui and not _gateway_env(CLOUD_ENV[provider]):
            raise AgentError(f'No API key for {provider} is configured (Configure AI Provider). See: agents.py models')
        return ref
    if provider in providers:
        return ref
    raise AgentError(f'unknown model provider "{provider}" (see: agents.py models)')


# ── planning a change ─────────────────────────────────────────────────────

def _csv(v):
    if v is None:
        return None
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return [x.strip() for x in str(v).split(',') if x.strip()]


def _workspace_ok(path):
    real = os.path.normpath(path)
    if not (real == WORKSPACE_ROOT or real.startswith(WORKSPACE_ROOT + '/')):
        raise AgentError(f'workspace must be inside {WORKSPACE_ROOT}')
    return real


def _merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _merge(dst[k], v)
        else:
            dst[k] = v
    return dst


def plan(cfg, ops, ui=False):
    """Turn [{op, id, fields}] into one config patch plus the agents to delete.
    Returns (patch, notes, scaffold, deletes)."""
    ents = entries(cfg)
    patch = {}
    ap = patch.setdefault('agents', {}).setdefault('entries', {})
    notes, scaffold, deletes = [], [], []
    final_ids = set(ents)
    for o in ops:
        if o['op'] == 'create':
            final_ids.add(o['id'])
        elif o['op'] == 'delete':
            final_ids.discard(o['id'])

    # Main's spawn list, edited in memory, written once at the end.
    main_allow = allow_list(ents.get(MAIN) or {})
    main_allow_orig = list(main_allow)

    def set_main_spawn(aid, on):
        nonlocal main_allow
        if on:
            if '*' not in main_allow and aid not in main_allow:
                main_allow.append(aid)
        else:
            if '*' in main_allow:
                main_allow = sorted(i for i in final_ids if i not in (MAIN, aid))
            main_allow = [i for i in main_allow if i != aid]

    for o in ops:
        op, aid, f = o['op'], o['id'], o.get('fields') or {}
        unknown = set(f) - set(FIELDS)
        if unknown:
            raise AgentError(f'unknown field(s): {", ".join(sorted(unknown))}')
        if not ID_RE.match(aid or ''):
            raise AgentError(f'agent id "{aid}": lowercase letters, digits and "-", starting with a letter, max 32')
        if aid == MAIN and op != 'update':
            raise AgentError('the main agent cannot be created or deleted here')
        if aid == MAIN and not ui:
            raise AgentError('the main agent is changed in the StartOS actions (Configure AI Provider), not here')
        exists = aid in ents

        if op == 'delete':
            if not exists:
                raise AgentError(f'no agent "{aid}"')
            deletes.append(aid)
            set_main_spawn(aid, False)
            for other, e in ents.items():
                if other in (aid, MAIN) or other not in final_ids:
                    continue
                lst = allow_list(e)
                if aid in lst:
                    rest = [i for i in lst if i != aid]
                    _merge(ap.setdefault(other, {}), {'subagents': {'allowAgents': rest or None}})
            notes.append(f'deleted {aid} (its workspace files are kept)')
            continue

        if op == 'create' and exists:
            raise AgentError(f'agent "{aid}" already exists; use update')
        if op == 'update' and not exists:
            raise AgentError(f'no agent "{aid}"; use create')
        cur = ents.get(aid) or {}
        out = {}

        if op == 'create':
            f.setdefault('workspace', f'{AGENTS_DIR}/{aid}')
            f.setdefault('mainCanSpawn', True)
            if not ui:
                f.setdefault('profile', 'minimal')
                f.setdefault('skills', 'none')
            if 'model' not in f:
                raise AgentError('create needs --model (see: agents.py models)')

        if 'name' in f:
            out['name'] = (f['name'] or '').strip() or None
        if 'model' in f:
            out['model'] = check_model(cfg, (f['model'] or '').strip(), ui, patch)
        tools = {}
        cur_tools = cur.get('tools') or {}
        if 'profile' in f:
            prof = f['profile'] or 'inherit'
            if prof not in PROFILES + ('inherit',):
                raise AgentError(f'profile must be one of {", ".join(PROFILES)}')
            if not ui and prof not in SAFE_PROFILES:
                raise AgentError(f'profile "{prof}" can only be switched on by a person, in StartOS → OpenClaw → Configure Agents')
            tools['profile'] = None if prof == 'inherit' else prof
        if 'extraTools' in f:
            extra = _csv(f['extraTools'])
            bad = sorted(set(extra) & POWERFUL_TOOLS)
            if bad and not ui:
                raise AgentError(f'{", ".join(bad)}: only a person can switch these on, in StartOS → OpenClaw → Configure Agents')
            # An entry that already uses an allow-only list keeps that form
            # (`allow` and `alsoAllow` cannot both be set).
            key = 'allow' if 'allow' in cur_tools else 'alsoAllow'
            tools[key] = extra or None
        if 'blockedTools' in f or (op == 'create' and not ui):
            deny = _csv(f.get('blockedTools')) or []
            if not ui:
                deny += [t for t in ALWAYS_BLOCKED if t not in deny]
            tools['deny'] = deny or None
        elif not ui and op == 'update':
            have = list(cur_tools.get('deny') or [])
            missing = [t for t in ALWAYS_BLOCKED if t not in have]
            if missing:
                tools['deny'] = have + missing
        if tools:
            out['tools'] = tools
        if 'skills' in f:
            s = f['skills']
            if s in ('all', None):
                out['skills'] = None
            elif s == 'none':
                out['skills'] = []
            else:
                out['skills'] = _csv(s)
        if 'canSpawn' in f:
            lst = _csv(f['canSpawn'])
            for target in lst:
                if target != '*' and target not in final_ids:
                    raise AgentError(f'{aid} can spawn "{target}", but there is no such agent')
            if '*' in lst and not ui:
                raise AgentError('"can spawn any agent" can only be switched on in Configure Agents')
            out['subagents'] = {'allowAgents': lst or None}
        if 'workspace' in f:
            ws = _workspace_ok((f['workspace'] or f'{AGENTS_DIR}/{aid}').strip())
            out['workspace'] = ws
            scaffold.append((aid, ws, f.get('name') or cur.get('name') or aid))
        if 'mainCanSpawn' in f and aid != MAIN and f['mainCanSpawn'] is not None:
            set_main_spawn(aid, bool(f['mainCanSpawn']))

        if op == 'create':
            # A new entry: drop the "unset" markers instead of sending nulls.
            def clean(d):
                return {k: clean(v) if isinstance(v, dict) else v
                        for k, v in d.items() if v is not None and not (isinstance(v, dict) and not clean(v))}
            out = clean(out)
            notes.append(f'created {aid}')
        else:
            notes.append(f'updated {aid}: {", ".join(sorted(f))}')
        if isinstance(ap.get(aid), dict):
            _merge(ap[aid], out)
        else:
            ap[aid] = out

    if main_allow != main_allow_orig:
        main_allow = [i for i in main_allow if i == '*' or i in final_ids]
        _merge(ap.setdefault(MAIN, {}), {'subagents': {'allowAgents': main_allow or None}})
        notes.append(f'main agent can spawn: {", ".join(main_allow) or "nobody"}')
    return patch, notes, scaffold, deletes


# ── writing ───────────────────────────────────────────────────────────────

AGENTS_TEMPLATE = """# {name}

<!-- This agent's instructions. A spawned agent sees only this file (not
SOUL.md, IDENTITY.md or MEMORY.md), so everything it must know goes here. -->

## Role

{name} is a helper agent spawned by the main agent for focused tasks.
Describe what it does, and what it must not do.

## How to work

- Do only the task you were given; report back briefly.
- If something is unclear or out of scope, say so instead of guessing.
- Your final reply reaches the main agent cut at about 4,000 characters.
  For anything longer, write the full result to a file in your workspace
  and reply with its path and a short summary.

## Tools

Which tools and skills this agent has is set in StartOS → OpenClaw →
Configure Agents (or with /opt/skills/agents/agents.py).
"""


def write_scaffold(items):
    made = []
    for aid, ws, name in items:
        os.makedirs(ws, exist_ok=True)
        path = os.path.join(ws, 'AGENTS.md')
        if not os.path.exists(path):
            with open(path, 'w') as f:
                f.write(AGENTS_TEMPLATE.format(name=name))
            made.append(path)
    return made


def openclaw_patch(patch, dry_run):
    cmd = ['openclaw', 'config', 'patch', '--stdin']
    if dry_run:
        cmd.append('--dry-run')
    env = {**os.environ, 'HOME': DATA, 'OPENCLAW_STATE_DIR': STATE, 'NO_COLOR': '1'}
    r = subprocess.run(cmd, input=json.dumps(patch), env=env, capture_output=True, text=True, timeout=180)
    out = (r.stdout + r.stderr).strip()
    if r.returncode != 0:
        raise AgentError(f'OpenClaw refused the change:\n{out}')
    return out


def openclaw_delete(aid):
    # OpenClaw's own deletion: config entry, agent state and sessions. A
    # workspace inside the main workspace is kept (OpenClaw retains nested
    # workspaces), so persona files stay in git.
    env = {**os.environ, 'HOME': DATA, 'OPENCLAW_STATE_DIR': STATE, 'NO_COLOR': '1'}
    r = subprocess.run(['openclaw', 'agents', 'delete', aid, '--force', '--json'], env=env,
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise AgentError(f'OpenClaw could not delete {aid}:\n{(r.stdout + r.stderr).strip()}')
    return r.stdout.strip()


def apply(ops, ui=False, dry_run=False):
    cfg = read_config()
    patch, notes, scaffold, deletes = plan(cfg, ops, ui)
    has_patch = bool(patch['agents']['entries']) or len(patch) > 1
    if not has_patch and not deletes:
        return {'ok': True, 'changed': False, 'notes': ['no change'], 'patch': patch}
    result = openclaw_patch(patch, dry_run) if has_patch else ''
    if dry_run:
        return {'ok': True, 'changed': False, 'dryRun': True, 'notes': notes,
                'patch': patch, 'delete': deletes, 'openclaw': result}
    deleted = [openclaw_delete(aid) and aid for aid in deletes]
    made = write_scaffold(scaffold)
    return {'ok': True, 'changed': True, 'dryRun': False, 'notes': notes,
            'createdFiles': made, 'deleted': deleted, 'patch': patch, 'openclaw': result}


# ── CLI ───────────────────────────────────────────────────────────────────

def _fields(a):
    f = {}
    if a.name is not None:
        f['name'] = a.name
    if a.model is not None:
        f['model'] = a.model
    if a.profile is not None:
        f['profile'] = a.profile
    if a.extra_tools is not None:
        f['extraTools'] = a.extra_tools
    if a.blocked_tools is not None:
        f['blockedTools'] = a.blocked_tools
    if a.skills is not None:
        f['skills'] = a.skills if a.skills in ('all', 'none') else _csv(a.skills)
    if a.can_spawn is not None:
        f['canSpawn'] = a.can_spawn
    if a.main_can_spawn is not None:
        f['mainCanSpawn'] = a.main_can_spawn == 'yes'
    if a.workspace is not None:
        f['workspace'] = a.workspace
    return f


def main(argv):
    ap = argparse.ArgumentParser(prog='agents.py', add_help=True,
                                 description='Manage OpenClaw agents (see SKILL.md).')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('list'); p.add_argument('--json', action='store_true')
    p = sub.add_parser('show'); p.add_argument('id')
    p = sub.add_parser('models'); p.add_argument('--json', action='store_true')
    for name in ('create', 'update'):
        p = sub.add_parser(name)
        p.add_argument('id')
        p.add_argument('--name'); p.add_argument('--model'); p.add_argument('--profile')
        p.add_argument('--extra-tools'); p.add_argument('--blocked-tools'); p.add_argument('--skills')
        p.add_argument('--can-spawn'); p.add_argument('--main-can-spawn', choices=('yes', 'no'))
        p.add_argument('--workspace'); p.add_argument('--dry-run', action='store_true')
    p = sub.add_parser('delete'); p.add_argument('id'); p.add_argument('--dry-run', action='store_true')
    # Used by the StartOS action: {"ops": [...]} on stdin, person-level rules.
    p = sub.add_parser('apply'); p.add_argument('--ui', action='store_true'); p.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(argv)
    try:
        if a.cmd == 'list':
            cfg = read_config()
            rows = [describe(cfg, i) for i in sorted(entries(cfg))]
            if a.json:
                print(json.dumps(rows, indent=2))
            else:
                for r in rows:
                    spawn = '' if r['id'] == MAIN else (' main-can-spawn' if r['mainCanSpawn'] else ' NOT-spawnable-by-main')
                    print(f"{r['id']:<16} model={r['model']} profile={r['profile']} skills="
                          f"{r['skills'] if r['skills'] == 'all' else (','.join(r['skills']) or 'none')}"
                          f" can-spawn={','.join(r['canSpawn']) or '-'}{spawn}")
        elif a.cmd == 'show':
            print(json.dumps(describe(read_config(), a.id), indent=2))
        elif a.cmd == 'models':
            ch = model_choices(read_config())
            if a.json:
                print(json.dumps([{'ref': r, 'label': l} for r, l in ch], indent=2))
            else:
                for r, l in ch:
                    print(f'{r:<48} {l}')
                print('default                                          the main agent\'s model')
        elif a.cmd in ('create', 'update', 'delete'):
            op = {'op': a.cmd, 'id': a.id}
            if a.cmd != 'delete':
                op['fields'] = _fields(a)
                if a.cmd == 'update' and not op['fields']:
                    raise AgentError('nothing to change (give at least one option)')
            r = apply([op], ui=False, dry_run=a.dry_run)
            print(('DRY RUN (nothing written): ' if a.dry_run else '') + '; '.join(r['notes']))
            for path in r.get('createdFiles') or []:
                print(f'created {path}: fill in this agent\'s instructions there')
            if a.dry_run:
                print(json.dumps(r['patch'], indent=2))
        elif a.cmd == 'apply':
            req = json.load(sys.stdin)
            print(json.dumps(apply(req.get('ops') or [], ui=a.ui, dry_run=a.dry_run)))
    except AgentError as e:
        if a.cmd == 'apply':
            print(json.dumps({'ok': False, 'error': str(e)}))
        else:
            print(f'agents: {e}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    try:
        import pwd
        has_node = pwd.getpwnam('node') is not None
    except KeyError:
        has_node = False
    if os.geteuid() == 0 and has_node and os.path.isdir('/data/.openclaw'):
        # openclaw.json and the workspace belong to the gateway user (node).
        os.execvp('runuser', ['runuser', '-u', 'node', '--', 'env', 'HOME=/data',
                              f'OPENCLAW_STATE_DIR={STATE}',
                              sys.executable, os.path.abspath(__file__), *sys.argv[1:]])
    sys.exit(main(sys.argv[1:]))
