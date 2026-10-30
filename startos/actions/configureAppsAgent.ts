import { sdk } from '../sdk'
import { openclawJson } from '../fileModels/openclaw.json'
import {
  APPS_AGENT_DEFAULTS,
  AppsAgentSettings,
  appsAgentJson,
} from '../fileModels/appsAgent.json'
import { agentModelChoices, OLLAMA_SERVER_ID } from '../modelCatalog'
import {
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  GROK_MODELS,
  OPENAI_MODELS,
} from './configureApiCredentials'

const { InputSpec, Value } = sdk

// Configure Apps Agent (since 2026.10.1:20): the agent between the main
// agent and the email and calendar agents (appsAgent.ts). It exists while
// mail or calendar is on; this form sets only its name, model and extra
// instructions.

const agentModel = Value.dynamicSelect(async () => {
  const cfg = ((await openclawJson
    .read()
    .once()
    .catch(() => undefined)) ?? {}) as any
  const main = cfg?.agents?.defaults?.model?.primary
  const current = (await appsAgentJson
    .read((s) => s.model)
    .once()
    .catch(() => undefined)) as string | undefined
  return {
    name: 'Apps Agent Model',
    description:
      'The model that passes jobs to the email and calendar agents and returns their reports unchanged. It never reads mail or events itself, so a smaller, cheaper model is usually enough.',
    default: 'default',
    values: {
      default: 'Same as the main agent' + (main ? ` (${main})` : ''),
      ...(await agentModelChoices(
        {
          anthropic: ANTHROPIC_MODELS,
          openai: OPENAI_MODELS,
          google: GEMINI_MODELS,
          xai: GROK_MODELS,
        },
        cfg?.models?.providers?.[OLLAMA_SERVER_ID]?.baseUrl,
        current && current !== 'default' ? [current] : [],
      )),
    },
  }
})

const inputSpec = InputSpec.of({
  name: Value.text({
    name: 'Name',
    description:
      'How the agent is listed in OpenClaw. A persona (name, tone) goes in the files SOUL.md and IDENTITY.md in its workspace folder (workspaces/apps), which are yours; its reports stay plain JSON for the main agent either way.',
    required: true,
    default: 'Apps',
    masked: false,
    placeholder: 'Apps',
  }),
  agentModel,
  extraInstructions: Value.textarea({
    name: 'Extra Instructions (optional)',
    description:
      "Added to the apps agent's instructions. They cannot loosen its rules.",
    required: false,
    default: null,
    minRows: 2,
    maxRows: 8,
    placeholder: null,
  }),
})

export const configureAppsAgent = sdk.Action.withInput(
  'configure-apps-agent',

  async () => ({
    name: 'Configure Apps Agent',
    description:
      'The agent your main agent asks about mail and calendars. It passes each job to the email or calendar agent and brings back their reports unchanged; its only tool is asking them. It exists while Email or Calendar is set up. Saving restarts OpenClaw.',
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  inputSpec,

  async () => {
    const s = await appsAgentJson
      .read()
      .once()
      .catch(() => null)
    return {
      name: s?.name || APPS_AGENT_DEFAULTS.name,
      agentModel: s?.model || 'default',
      extraInstructions: s?.extraInstructions || null,
    } as any
  },

  async ({ effects, input }) => {
    const i = input as any
    const settings: AppsAgentSettings = {
      name: String(i.name ?? '').trim() || APPS_AGENT_DEFAULTS.name,
      model: String(i.agentModel || 'default'),
      extraInstructions: String(i.extraInstructions ?? '').trim() || undefined,
    }
    await appsAgentJson.write(effects, settings)
    await effects.restart()
    return {
      version: '1' as const,
      title: 'Apps Agent Configured',
      message: 'Settings saved. OpenClaw is restarting.',
      result: null,
    }
  },
)
