import { chmod, mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { sdk } from './sdk'

// Secrets for the gateway (provider API keys, manually entered service
// keys, gog's keyring password) do not go on the daemon's command line.
// StartOS starts every daemon as `start-container … --env=NAME=value …`,
// and any user on the server can read a command line (`ps`), so values
// passed that way were visible outside the container. They are written to
// a file only the gateway user can read (0600; the chown oneshot makes it
// node's), and the gateway's command loads it with the shell before it
// execs OpenClaw. The gateway's environment is unchanged; only root and the
// gateway user can read a process's environment.

export const GATEWAY_SECRETS = '/data/.startos/gateway-secrets.env'
const secretsPath = sdk.volumes.main.subpath('.startos/gateway-secrets.env')

const shQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`

/** Write the gateway's secret environment (rewritten at every start). */
export async function writeGatewaySecrets(vars: Record<string, string>) {
  await mkdir(dirname(secretsPath), { recursive: true })
  const lines = Object.entries(vars)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${shQuote(v)}`)
  await writeFile(
    secretsPath,
    '# Written by the package at every start. Secrets: do not share.\n' +
      lines.join('\n') +
      '\n',
    { mode: 0o600 },
  )
  await chmod(secretsPath, 0o600)
}

/** `cmd`, run after loading the gateway's secret environment. */
export function withGatewaySecrets(cmd: string[]): [string, ...string[]] {
  return [
    'sh',
    '-c',
    `set -a; [ -r ${GATEWAY_SECRETS} ] && . ${GATEWAY_SECRETS}; set +a; exec "$@"`,
    'with-secrets',
    ...cmd,
  ]
}
