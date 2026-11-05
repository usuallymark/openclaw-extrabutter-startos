import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

// Configure Contacts (since 2026.10.1:31). In /data/.openclaw-contacts, a
// folder the gateway user cannot enter (the chown step skips it; the
// contacts launcher sets it to root:openclaw-contacts 0710). The file is
// root's (0600), so a pasted Google sign-in is out of the agents' reach;
// the imported vCard file next to it is readable by the service only.

export const CONTACTS_ROOT_SUBPATH = '.openclaw-contacts'
export const CONTACTS_SETTINGS_SUBPATH = `${CONTACTS_ROOT_SUBPATH}/settings.json`
export const CONTACTS_VCARD_SUBPATH = `${CONTACTS_ROOT_SUBPATH}/contacts.vcf`
export const contactsSources = ['off', 'vcard', 'google'] as const

const shape = z.looseObject({
  source: z.enum(contactsSources).catch('off'),
  // The Google account the sign-in is for (shown in the health line).
  account: z.string().optional().catch(undefined),
  token: z
    .looseObject({
      source: z.enum(['from-vaultwarden', 'manual']).catch('from-vaultwarden'),
      value: z.string().optional().catch(undefined),
    })
    .catch({ source: 'from-vaultwarden' as const, value: undefined }),
  // The last vCard import: when, from which file, how many contacts.
  imported: z
    .looseObject({
      at: z.string().catch(''),
      file: z.string().catch(''),
      count: z.number().catch(0),
    })
    .optional()
    .catch(undefined),
  agent: z
    .looseObject({
      model: z.string().catch('default'),
      extraInstructions: z.string().optional().catch(undefined),
    })
    .catch({ model: 'default' }),
})

export type ContactsSettings = z.infer<typeof shape>

export const CONTACTS_DEFAULTS: ContactsSettings = {
  source: 'off',
  token: { source: 'from-vaultwarden' },
  agent: { model: 'default' },
}

export const contactsSettingsJson = FileHelper.json(
  { base: sdk.volumes.main, subpath: CONTACTS_SETTINGS_SUBPATH },
  shape,
)
