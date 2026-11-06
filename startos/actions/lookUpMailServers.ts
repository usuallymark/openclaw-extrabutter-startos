import { sdk } from '../sdk'
import { describe, discover } from '../mailDiscovery'
import { GROUP_APPS } from './groups'

const { InputSpec, Value } = sdk

// Look Up Mail Servers (since :35): what "Other provider (find servers
// automatically)" in Configure Email would find for an address. Saves
// nothing and asks for no password.
export const lookUpMailServers = sdk.Action.withInput(
  'look-up-mail-servers',

  async () => ({
    name: 'Look Up Mail Servers',
    description:
      "Shows the IMAP and SMTP servers Configure Email would find for an address: the provider's own settings, Thunderbird's provider directory, the domain's mail server, DNS. Saves nothing; no password needed.",
    warning: null,
    allowedStatuses: 'any',
    group: GROUP_APPS,
    visibility: 'enabled',
  }),

  InputSpec.of({
    address: Value.text({
      name: 'Email Address',
      description: 'Any address at the provider, e.g. you@example.com.',
      required: true,
      default: null,
      masked: false,
      placeholder: 'you@example.com',
      inputmode: 'email',
      patterns: [
        {
          regex: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
          description: 'Must be an email address, e.g. you@example.com',
        },
      ],
    }),
  }),

  async () => ({}),

  async ({ input }) => {
    const address = String(input.address ?? '').trim()
    const d = await discover(address)
    return {
      version: '1' as const,
      title: 'Mail Servers',
      message:
        d.kind === 'found'
          ? `Found for ${address}. Nothing was saved.`
          : `Nothing to save for ${address}.`,
      result: {
        type: 'single' as const,
        value: describe(d, address),
        copyable: true,
        qr: false,
        masked: false,
      },
    }
  },
)
