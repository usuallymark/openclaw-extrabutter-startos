export const DEFAULT_LANG = 'en_US'

const dict = {
  // main.ts
  'Starting OpenClaw Gateway!': 0,
  'Web Interface': 1,
  'OpenClaw Gateway is ready': 2,
  'OpenClaw Gateway is not ready': 3,
  'Login to StartOS to enable start-cli authentication for managing the server': 4,

  // interfaces.ts
  'Web UI': 5,
  'The OpenClaw Gateway web interface providing WebChat and control panel': 6,

  // actions/configureApiCredentials.ts
  'Claude Opus 4.8 — most capable': 7,
  'Claude Opus 4.7': 8,
  'Claude Sonnet 4.6 — balanced': 9,
  'Claude Haiku 4.5 — fast & cheap': 10,
  'Claude Fable 5 — premium': 11,
  'GPT-5.5 — strongest': 12,
  'GPT-5.4': 13,
  'GPT-5.4 Mini — fast & cheap': 14,
  'Gemini 3.1 Pro': 15,
  'Gemini 3 Flash — fast': 16,
  'Grok 4.3 — flagship': 17,
  'Grok Build 0.1 — agentic coding': 18,
  'Default Model': 19,
  'The model this provider uses by default. Change it anytime from Web UI chat with the /model command.': 20,
  'Custom Model (optional)': 21,
  'Use an exact model id that is not in the list above. Leave blank to use the dropdown selection.': 22,
  'API Key': 23,
  'API key for this provider. Leave blank to keep the key already saved.': 24,
  'Anthropic (Claude)': 25,
  'OpenAI (GPT)': 26,
  'Google (Gemini)': 27,
  'xAI (Grok)': 28,
  'The exact model id your local server serves. Change it anytime from Web UI chat with the /model command.': 29,
  'Ollama (local)': 30,
  'vLLM (local)': 31,
  'llama.cpp (local)': 32,
  Disabled: 33,
  'Primary Provider': 34,
  'The backend your agent uses by default. Cloud providers (Anthropic, OpenAI, Google, xAI) need an API key; local backends (Ollama, vLLM, llama.cpp) run on your StartOS server and are added as a dependency.': 35,
  'Fallback Provider (optional)': 36,
  'Used automatically when the primary is rate-limited or unavailable. Choose Disabled to skip.': 37,
  'Configure AI Provider': 38,
  'Choose the AI backend your agent uses — a cloud provider (with an API key) or a local model server (Ollama, vLLM, llama.cpp) — pick a model, and optionally add a fallback.': 39,
  'vLLM is selected but its API key could not be read from vllm:public/credentials.json. Make sure vLLM is installed and running.': 40,

  // actions/loginToOs.ts
  'StartOS Master Password': 41,
  'Your StartOS server master password': 42,
  'Enter master password': 43,
  'Login to StartOS': 44,
  'Authenticate start-cli with your StartOS server': 45,
  'This will give root access to your StartOS server to this package. Only do this for a server designated for development purposes.': 46,
  'No host configured. The host URL is set automatically from the OS IP address.': 47,
  'Login failed': 48,
  'Unknown error': 49,
  'Login Successful': 50,
  'start-cli is now authenticated with your StartOS server.': 51,

  // init/taskConfigureApi.ts
  'Configure your AI provider credentials to use OpenClaw': 52,

  // actions/connectTelegram.ts
  'Pairing (approve code on first contact)': 53,
  'Open (anyone can DM)': 54,
  'Bot Token': 55,
  'Telegram bot token from @BotFather. Create a bot at https://t.me/BotFather and copy the token.': 56,
  'DM Policy': 57,
  'How to handle direct messages from new users': 58,
  'Connect Telegram': 59,
  'Connect a Telegram bot so you can chat with your agent from Telegram. Create a bot with @BotFather first.': 60,
  Channels: 61,
  'Telegram Connected': 62,
  'Telegram bot configured. Restart the service for changes to take effect. DM your bot to start chatting with your agent.': 63,

  // actions/connectWhatsapp.ts
  'Allowlist (only allowed numbers)': 64,
  'Allowed Phone Numbers': 65,
  'Comma-separated phone numbers in international format (e.g. +15551234567,+15559876543). Only used with Allowlist policy.': 66,
  'Connect WhatsApp': 67,
  'Connect WhatsApp so you can chat with your agent. Links your WhatsApp account via QR code.': 68,
  'WhatsApp login failed': 69,
  'WhatsApp QR Code': 70,
  'Scan this QR code with WhatsApp (Settings > Linked Devices > Link a Device):': 71,

  // actions/setPassword.ts
  'Reset Password': 72,
  'Set Password': 73,
  'Reset your OpenClaw gateway password': 74,
  'Set the gateway password needed to log in to the Control UI': 75,
  'Password Set': 76,
  'Use this password to log in to the OpenClaw Control UI.': 77,

  // init/taskSetPassword.ts
  'Set your OpenClaw gateway password': 78,

  // actions/revokeStartOsAccess.ts
  'Revoke StartOS Access': 79,
  "Remove OpenClaw's stored start-cli authentication so it can no longer administer this StartOS server": 80,
  'OpenClaw will lose StartOS administrative access until you run Login to StartOS again.': 81,
  'StartOS Access Revoked': 82,
  "OpenClaw's stored start-cli authentication was removed. Run Login to StartOS to grant access again.": 83,

  // actions/configureApiCredentials.ts
  'The selected local backend is not yet reachable on the internal network. Make sure it is installed and running, then run Configure AI Provider again.': 84,

  // actions/configureSimplex.ts
  'Configure SimpleX': 85,
  'Enable the SimpleX channel and configure how it handles direct messages.': 86,
  'Enable SimpleX Channel': 87,
  'Install the openclaw-simplex plugin and configure it to use the SimpleX Websocket Bridge service. Note: installation may take a few minutes.': 88,
  Enabled: 89,
  'Could not install the SimpleX plugin': 90,
  'Could not uninstall the SimpleX plugin: ': 91,
  'The SimpleX Websocket Bridge is not reachable on the internal network. Make sure it is installed and running, then try again.': 92,
  'Submit Configure SimpleX to upgrade the SimpleX plugin': 93,

  // repair-openclaw action
  'Repair OpenClaw': 94,
  'Run one of OpenClaw’s maintenance commands against the stopped service.': 95,
  'Back up the service before applying repairs.': 96,
  Command: 97,
  'Repair config and database (doctor --fix)': 98,
  'Apply recommended repairs': 99,
  'If not checked, no changes will be made.': 100,
  'Import sessions to SQLite (doctor --session-sqlite)': 101,
  'Apply changes': 102,
  'Maintenance Result': 103,
  'Exit Code': 104,
  Output: 105,
  'No output': 106,

  // versions/current.ts
  'OpenClaw could not migrate its state': 107,

  // approve-devices action
  'Approve Browser Pairing': 108,
  'Approve every browser waiting to pair with the Web UI. Log in to the Web UI first; it says "pairing required" until this runs.': 109,
  'Only run this right after you tried to log in yourself: every pending request is approved, and an approved browser keeps its access until you remove it in the Web UI.': 110,
  'Could not read pairing requests': 111,
  'Nothing to approve': 112,
  'No browser is waiting to pair. Open the Web UI, log in with the gateway password, then run this action.': 113,
  'Could not approve pairing request': 114,
  'Pairing approved': 115,
  'The Web UI reconnects on its own; reload it if it does not.': 116,
  Approved: 117,

  // main.ts — Qdrant
  'Qdrant Vector Database': 118,
  'Qdrant is ready': 119,
  'Qdrant is not ready': 120,

  // actions/configureApiCredentials.ts — live model lists, memory embeddings
  'The model this provider uses by default. The list comes live from the provider when its API key is saved (otherwise a built-in list). Change it anytime from Web UI chat with the /model command.': 121,
  'Embedding Model': 122,
  'Listed live from the provider when a key for it is saved; otherwise a built-in list.': 123,
  'Only needed if this provider is not also your chat provider above (then its chat key is used). Leave blank to keep the key already saved.': 124,
  'Keyword search only (no embeddings)': 125,
  'Ollama (your own server)': 126,
  'Ollama URL': 127,
  'Base URL of your Ollama server, without /v1 (e.g. http://192.168.1.50:11434). Defaults to the Ollama URL from Configure External Services. A ".local" name needs a Custom Host Mapping there.': 128,
  'An embedding model your Ollama server has pulled, e.g. nomic-embed-text.': 129,
  'Other OpenAI-compatible server': 130,
  'Base URL': 131,
  'Base URL of the /v1/embeddings API, e.g. https://api.example.com/v1/': 132,
  'Leave blank to keep the key already saved.': 133,
  'Memory Embeddings': 134,
  "How OpenClaw's memory search (MEMORY.md, memory files, past sessions) finds related notes. Independent of the chat provider above.\n\nChanging it makes OpenClaw rebuild its memory index once (with a paid API this costs a little). Vector collections in Qdrant are NOT changed: each keeps the embedding model it was built with.": 135,
  'Saved. Memory embeddings: no API key is saved for this provider, so memory search falls back to keywords until you add one or choose another option.': 136,
  'Saved. OpenClaw restarts now. If you changed Memory Embeddings, its memory index is rebuilt once; the health skill (or `openclaw memory status`) shows when vector search is ready.': 137,
  'AI provider saved': 138,
  Off: 139,
  'Local Chat Models for Agents': 140,
  'Offer the chat models on your own Ollama server to your agents (Configure Agents), so helper agents can run locally at no API cost.\n\nOnly models that can call tools are offered; embedding-only models are left out. Models you pull later appear in Configure Agents without saving this again. Local models are usually weaker than cloud models at multi-step tool work: try one on a narrow task first.': 141,
  'Local Chat Models cannot be turned off while agents use them. Give these agents another model in Configure Agents first:': 142,
  'Could not reach your Ollama server to read its models. Check the URL (and a Custom Host Mapping for a ".local" name) and that Ollama is running, then save again.': 143,

  // actions/configureAgents.ts
  'Minimal: almost no tools (add what it needs below)': 144,
  'Messaging: session and conversation tools': 145,
  'Coding: files, shell, web, memory, sessions': 146,
  'Full: every tool (no restriction)': 147,
  'Same as the main agent (global tool setting)': 148,
  ID: 149,
  'Short permanent name used to spawn it (e.g. "researcher"). Lowercase letters, digits and "-". Changing the ID makes a new agent.': 150,
  'Lowercase letters, digits and "-", starting with a letter (max 32).': 151,
  'Display Name': 152,
  'Optional, e.g. "Researcher".': 153,
  "Main agent's model": 154,
  Model: 155,
  'Cloud models of the providers with a saved API key, and (if turned on in Configure AI Provider → Local Chat Models) the tool-capable models on your own Ollama server, listed live.': 156,
  'Tool Profile': 157,
  'The base set of tools. Spawned agents never get gateway, cron, message or a few other system tools, whatever is chosen here.': 158,
  'Extra Tools': 159,
  'Comma-separated tools added to the profile, e.g. read, web_search, web_fetch, memory_search, view_image, browser, write, edit, exec; or groups such as group:web, group:memory, group:fs.': 160,
  'Blocked Tools': 161,
  'Comma-separated tools that are always off for this agent.': 162,
  Skills: 163,
  '"all" (every skill the main agent has), "none", or a comma-separated list of skill names, e.g. health, qdrant, ntfy.': 164,
  'Can Spawn': 165,
  'Comma-separated IDs of other agents this one may start, e.g. "researcher, writer". "*" means any agent. Leave empty for none.': 166,
  'Main Agent Can Spawn': 167,
  'Whether the main agent may start this agent.': 168,
  'Instructions Folder': 169,
  "Folder holding this agent's AGENTS.md (the only instructions a spawned agent sees). Leave empty for workspace/workspaces/<ID>. A starter AGENTS.md is created there if missing. Must be inside /data/.openclaw/workspace.": 170,
  Agents: 171,
  "Helper agents the main agent (or another agent) can spawn for focused work. The main agent can also create and change them in conversation (agents skill); they appear here.\n\nEach agent's personality and instructions live in AGENTS.md in its folder; this form sets what it is allowed to do and which model it runs on. Deleting an agent keeps its folder.": 172,
  'Configure Agents': 173,
  'Add, change or remove the helper agents the main agent can spawn: their model (cloud or your own Ollama server), tools, skills and who may start them.': 174,
  'No changes': 175,
  'Nothing was changed.': 176,
  'Not saved:': 177,
  'the agents helper failed': 178,
  'Agents saved': 179,
  'Starter instructions were created in:': 180,
  'Ask the main agent to fill them in with you, or edit them in the workspace.': 181,
  'Changes apply without a restart.': 182,
  'This replaces the current gateway password. Every browser and app signed in with the old one will have to sign in again with the new one.': 183,
} as const

/**
 * Plumbing. DO NOT EDIT.
 */
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
