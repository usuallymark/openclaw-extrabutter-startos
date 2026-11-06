import { readdir } from 'fs/promises'
import { sdk } from '../sdk'
import { openclawJson } from '../fileModels/openclaw.json'
import {
  ContactsSettings,
  contactsSettingsJson,
} from '../fileModels/contactsSettings.json'
import {
  CONTACTS_IMPORT_DIR,
  CONTACTS_VAULT,
  writeContactsSettings,
} from '../contactsService'
import { parseCalendarSignIn } from '../calendarService'
import { inOpenclawContainer } from '../gatewayContainer'
import { agentModelChoices, OLLAMA_SERVER_ID } from '../modelCatalog'
import {
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  GROK_MODELS,
  OPENAI_MODELS,
} from './configureApiCredentials'
import { GROUP_APPS } from './groups'

const { InputSpec, Value, Variants } = sdk

// Configure Contacts (since 2026.10.1:31): the contacts service and the
// contacts agent, read only. Sources: a vCard file the owner imports (any
// provider), or the assistant's Google account (People API, its own
// sign-in with contacts.readonly only).

const EMAIL_RE = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'
const KEEP = '(keep the address book already imported)'
const importDir = sdk.volumes.main.subpath(
  `.openclaw/workspace/${CONTACTS_IMPORT_DIR}`,
)

const saved = () =>
  contactsSettingsJson
    .read()
    .once()
    .catch(() => null)

/** The .vcf files waiting in the workspace folder (names only). */
async function importable(): Promise<string[]> {
  const names = await readdir(importDir).catch(() => [] as string[])
  return names
    .filter((n) => /\.(vcf|vcard)$/i.test(n) && !n.startsWith('.'))
    .sort()
    .slice(0, 50)
}

const vcardFile = Value.dynamicSelect(async () => {
  const s = await saved()
  const files = await importable()
  const had = !!s?.imported?.count
  const values: Record<string, string> = {}
  if (had)
    values['keep'] =
      `${KEEP}: ${s?.imported?.count} contacts from ${s?.imported?.file || 'a file'}, ${s?.imported?.at || ''}`.trim()
  for (const f of files) values[`file:${f}`] = `Import ${f}`
  if (!Object.keys(values).length)
    values['none'] =
      `No file yet: put a .vcf file in the workspace folder ${CONTACTS_IMPORT_DIR}`
  return {
    name: 'Address Book File',
    description: `The vCard file (.vcf) to read, from the folder ${CONTACTS_IMPORT_DIR} in the assistant's workspace: give the file to your assistant and ask it to save it there, or copy it there yourself. Exports: Google Contacts → Export → vCard; iPhone/iCloud → Contacts → select all → Export vCard; Outlook → People → Manage → Export. Importing copies it into the contacts service's own folder, where the agents cannot read it.`,
    default: had ? 'keep' : files.length ? `file:${files[0]}` : 'none',
    values,
  }
})

const SIGN_IN_VARIANTS = {
  'from-vaultwarden': {
    name: 'Fetch from Vaultwarden',
    spec: InputSpec.of({}),
  },
  manual: {
    name: 'Paste here',
    spec: InputSpec.of({
      value: Value.textarea({
        name: 'Sign-in (JSON)',
        description:
          'The whole line printed by google-signin.py. Leave blank to keep the sign-in already saved.',
        required: false,
        default: null,
        minRows: 3,
        maxRows: 8,
        placeholder: 'Leave blank to keep the saved sign-in.',
      }),
    }),
  },
}

const signIn = Value.dynamicUnion(async () => ({
  name: 'Google Sign-in',
  description: `A sign-in for the assistant's Google account with only the contacts permission, made once on your computer: python3 google-signin.py --scopes contacts.readonly CLIENT.json (the same OAuth client as the calendar's; enable the People API in that Google Cloud project first). Fetch from Vaultwarden: item "${CONTACTS_VAULT.item}", hidden custom field "${CONTACTS_VAULT.field}" with the whole line the script printed (only the contacts service can fetch it). Paste here: stored once, on this server only.`,
  default:
    (await saved())?.token?.source === 'manual' ? 'manual' : 'from-vaultwarden',
  disabled: false,
  variants: Variants.of(SIGN_IN_VARIANTS),
}))

const account = Value.dynamicText(async () => ({
  name: 'Google Account',
  description:
    "The assistant's Google account the sign-in is for (shown in the health line). Filled in from a pasted sign-in when left blank.",
  required: false,
  default: (await saved())?.account || null,
  masked: false,
  placeholder: 'assistant@gmail.com',
  inputmode: 'email' as const,
  patterns: [{ regex: EMAIL_RE, description: 'An email address' }],
}))

const sourceChoice = Value.dynamicUnion(async () => ({
  name: 'Contacts',
  description:
    "Off: no contacts service, no contacts agent.\nvCard file: an address book exported from any app (Google, iPhone, Outlook), imported here; to update it, import a newer export.\nGoogle account: the contacts of the assistant's own Google account, read live (Google does not share one account's contacts with another, so these are the contacts kept in the assistant's account). \"Other contacts\" (everyone the account has emailed) are not read.\nEither way read only: the contacts agent can search and look up contacts and birthdays, never change them.",
  default: (await saved())?.source ?? 'off',
  disabled: false,
  variants: Variants.of({
    off: { name: 'Off', spec: InputSpec.of({}) },
    vcard: {
      name: 'vCard file (any provider)',
      spec: InputSpec.of({
        file: vcardFile,
        removeAfter: Value.toggle({
          name: 'Remove the File from the Workspace After Importing',
          description:
            'On: the copy in the workspace is deleted once imported, so the agents no longer have your whole address book. Off: it stays there.',
          default: true,
        }),
      }),
    },
    google: {
      name: "Google account (the assistant's)",
      spec: InputSpec.of({ signIn, account }),
    },
  }),
}))

const agentModel = Value.dynamicSelect(async () => {
  const cfg = ((await openclawJson
    .read()
    .once()
    .catch(() => undefined)) ?? {}) as any
  const main = cfg?.agents?.defaults?.model?.primary
  const current = (await saved())?.agent?.model
  return {
    name: 'Contacts Agent Model',
    description:
      'The model that looks up contacts. A smaller, cheaper model is usually enough (the agent cannot change anything, run commands or read passwords).',
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
  source: sourceChoice,
  agentModel,
  extraInstructions: Value.textarea({
    name: 'Extra Instructions (optional)',
    description:
      'Added to the contacts agent\'s instructions, e.g. "Sam is my son". They cannot loosen its rules.',
    required: false,
    default: null,
    minRows: 2,
    maxRows: 8,
    placeholder: 'Sam is my son.',
  }),
})

export const configureContacts = sdk.Action.withInput(
  'configure-contacts',

  async () => ({
    name: 'Configure Contacts',
    description:
      'Connect an address book (a vCard file, or the assistant\'s Google account) and set up the contacts agent: the only agent that reads contacts, read only. Your main agent asks it ("Sam\'s number", "who is this address?", "birthdays this month"). Saving restarts OpenClaw.',
    warning: null,
    allowedStatuses: 'any',
    group: GROUP_APPS,
    visibility: 'enabled',
  }),

  inputSpec,

  async () => {
    const s = await saved()
    const src = s?.source ?? 'off'
    const files = await importable()
    return {
      source:
        src === 'vcard'
          ? {
              selection: 'vcard',
              value: {
                file: s?.imported?.count
                  ? 'keep'
                  : files.length
                    ? `file:${files[0]}`
                    : 'none',
                removeAfter: true,
              },
            }
          : src === 'google'
            ? {
                selection: 'google',
                value: {
                  signIn:
                    s?.token?.source === 'manual'
                      ? { selection: 'manual', value: { value: null } }
                      : { selection: 'from-vaultwarden', value: {} },
                  account: s?.account || null,
                },
              }
            : { selection: 'off', value: {} },
      agentModel: s?.agent?.model || 'default',
      extraInstructions: s?.agent?.extraInstructions || null,
    } as any
  },

  async ({ effects, input }) => {
    const raw = input as any
    const sel = raw.source?.selection ?? 'off'
    const v = raw.source?.value ?? {}
    const prior = await saved()
    let token: ContactsSettings['token'] = prior?.token ?? {
      source: 'from-vaultwarden',
    }
    let account = prior?.account
    let imported = prior?.imported
    let note = ''
    if (sel === 'google') {
      account =
        String(v.account ?? '')
          .trim()
          .toLowerCase() || account
      if (v.signIn?.selection === 'manual') {
        const pasted = String(v.signIn?.value?.value ?? '').trim()
        if (pasted) {
          const parsed = parseCalendarSignIn(pasted)
          if (!account && parsed.account) account = parsed.account.toLowerCase()
          if (
            parsed.scopes.length &&
            !parsed.scopes.some((s) =>
              ['contacts.readonly', 'contacts'].includes(s),
            )
          )
            throw new Error(
              `This sign-in does not allow reading contacts (it allows: ${parsed.scopes.join(', ')}). Run google-signin.py again with --scopes contacts.readonly.`,
            )
          token = { source: 'manual', value: pasted }
        } else if (prior?.token?.source === 'manual' && prior.token.value) {
          token = prior.token
        } else {
          throw new Error(
            'Paste the sign-in (the line printed by google-signin.py), or choose Fetch from Vaultwarden.',
          )
        }
      } else {
        token = { source: 'from-vaultwarden' }
      }
    }
    if (sel === 'vcard') {
      const choice = String(v.file ?? '')
      if (choice.startsWith('file:')) {
        const name = choice.slice(5)
        const res = await inOpenclawContainer(
          effects,
          'contacts-import',
          (sub) =>
            sub.exec(
              [
                'python3',
                '-I',
                '/opt/openclaw-contacts/importvcf.py',
                name,
                ...(v.removeAfter === false ? ['--keep'] : []),
              ],
              { user: 'root', timeout: 120_000 },
            ),
        )
        let out: any = {}
        try {
          out = JSON.parse(String(res.stdout).trim().split('\n').pop() || '{}')
        } catch {
          out = {}
        }
        if (!out.ok)
          throw new Error(
            `The file was not imported: ${out.error || String(res.stderr).trim().split('\n').pop() || 'unknown error'}`,
          )
        imported = {
          at: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
          file: name,
          count: Number(out.count) || 0,
        }
        note = ` Imported ${imported.count} contacts from ${name}${out.removed ? ' (removed from the workspace)' : ''}.${out.problems?.length ? ` Note: ${out.problems.join('; ')}.` : ''}`
      } else if (choice !== 'keep' || !prior?.imported?.count) {
        throw new Error(
          `Put a vCard file (.vcf) in the workspace folder ${CONTACTS_IMPORT_DIR} first, then open Configure Contacts again and choose it.`,
        )
      }
    }
    const settings: ContactsSettings = {
      ...(prior ?? {}),
      source: sel === 'vcard' || sel === 'google' ? sel : 'off',
      account: account || undefined,
      token,
      imported,
      agent: {
        ...(prior?.agent ?? {}),
        model: String(raw.agentModel || 'default'),
        extraInstructions:
          String(raw.extraInstructions ?? '').trim() || undefined,
      },
    } as ContactsSettings
    await writeContactsSettings(effects, settings)
    await effects.restart()
    return {
      version: '1' as const,
      title: 'Contacts Configured',
      message:
        (settings.source === 'off'
          ? 'Contacts is off. OpenClaw is restarting.'
          : 'Settings saved. OpenClaw is restarting; the contacts service starts on its own, and its state is shown as "Contacts Service" on the service page.') +
        note,
      result: null,
    }
  },
)
