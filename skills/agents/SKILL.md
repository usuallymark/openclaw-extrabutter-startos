---
name: agents
description: "Use this skill to create, change or remove OpenClaw agents (helper personas the main agent can spawn), or to list them and the models they can use. Triggers: 'make a new agent/persona/helper', 'give X a cheaper model', 'let the researcher call the writer', 'what agents do we have', 'remove that agent'."
---

# Agents: create and manage helper agents

An agent is an entry in OpenClaw's `agents.entries` with its own model,
tools, skills and instructions folder. The main agent spawns it for focused
work. The person can see and change every agent in StartOS → OpenClaw →
**Configure Agents**. That form and this helper edit the same config, so
anything you create appears there and anything they change there is what you
see here.

Always use the helper, never `openclaw config set` or a hand edit of
openclaw.json for agents.

```bash
A=/opt/skills/agents/agents.py
python3 $A list                 # every agent, one line each
python3 $A show ID              # one agent, all fields (JSON)
python3 $A models               # models an agent can be given right now
python3 $A create ID --model REF [--name "Name"] [--profile minimal|messaging] \
    [--extra-tools read,web_search] [--blocked-tools browser] \
    [--skills health,qdrant | all | none] [--can-spawn researcher,writer] \
    [--main-can-spawn yes|no] [--workspace PATH] [--dry-run]
python3 $A update ID [any of the same options]
python3 $A delete ID
```

`--dry-run` validates through OpenClaw and prints the change without
writing it. Changes apply without a restart; the agent can be spawned on the
next turn.

## Designing an agent with the person

1. **Interview.** What is it for? What must it never do? Which tools does it
   really need (files, web, memory)? Who spawns it: you, or another agent?
   Cheap or strong model?
2. **Propose** the plan in plain words: id, name, model, tools, skills, who
   can spawn it, and a draft of its instructions. Wait for a yes.
3. **Create** with the helper (dry run first if anything is unusual).
4. **Write its instructions** in `<workspace>/AGENTS.md` (the helper creates
   a starter file). A spawned agent sees **only AGENTS.md**: not SOUL.md,
   IDENTITY.md, USER.md or MEMORY.md. Everything it must know goes there.
   Keep the line about long results: OpenClaw cuts a spawned agent's final
   reply to 4,096 characters (ending "…") before it reaches you, with no
   setting to change that. Agents that produce long output must write it to
   a file in their workspace and reply with the path; read the file then.
5. **Try it**: spawn it on a small task and check the result.
6. **Save**: if the workspace is a git repository, commit the new files.
   Tell the person it is now listed under Configure Agents.

## Choosing settings

- **Model**: run `models`. `default` means the main agent's model. Lines
  starting with `ollama-server/` are free local models on the person's own
  Ollama server; they are weaker at multi-step tool work, so give them
  narrow tasks. Only tool-capable local models are offered.
- **Profile**: `minimal` gives almost no tools (only spawn and session tools
  when it may spawn others). Add what it needs with `--extra-tools`.
  `messaging` adds session and conversation tools.
- **Common extra tools**: `read` (read files), `write`, `edit`,
  `web_search`, `web_fetch`, `memory_search`, `memory_get`, `view_image`,
  `browser`; groups `group:web`, `group:memory`, `group:fs`.
- **Skills**: `none` (the default here), a list, or `all`.
- **Can spawn**: other agents this one may start. The main agent's own
  permission is `--main-can-spawn` (yes by default on create).

## What only the person can switch on

The helper refuses these, and says so; they are set in Configure Agents:

- the `coding` and `full` profiles;
- shell and system tools: `exec`, `process`, `code_execution`, `gateway`,
  `cron`, `nodes`, `computer`, `message`, `group:runtime`,
  `group:automation`, `group:openclaw`, `group:plugins`, `*`;
- "may spawn any agent" (`*`);
- changes to the main agent.

`gateway` and `cron` stay blocked for agents you create or update. Do not
try to work around a refusal; tell the person what you would need and where
they can switch it on.

## Deleting

`delete` removes the agent from OpenClaw (config, its sessions and state)
and from every "can spawn" list. Its instructions folder inside the
workspace is kept, so it can be restored from git or re-created. Confirm
with the person first.
