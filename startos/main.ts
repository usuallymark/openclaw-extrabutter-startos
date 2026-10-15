import { readFile, writeFile, mkdir, access } from 'fs/promises'
import { installRootCA, loginToOs } from './actions/loginToOs'
import { authProfilesJson } from './fileModels/authProfiles.json'
import { openclawJson } from './fileModels/openclaw.json'
import { startCliConfigYaml } from './fileModels/startCliConfig.yaml'
import { externalServicesJson } from './fileModels/externalServices.json'
import { i18n } from './i18n'
import {
  uiHostId,
  uiInterfaceId,
  qdrantHostId,
  qdrantInternalPort,
} from './interfaces'
import { sdk } from './sdk'
import { setGatewayContainer } from './gatewayContainer'
import { notInstalledMessage, resolveLocalServices } from './localServices'
import {
  mainMounts,
  qdrantMounts,
  uiPort,
  qdrantPort,
  webchatPort,
  webchatUploadPort,
} from './utils'
import { webchatJson } from './fileModels/webchat.json'
import { embeddingsJson } from './fileModels/embeddings.json'
import { watchSimplexAddress, withSimplexMounts } from './simplex'
import {
  MIN_PLUGIN_VERSION,
  SIMPLEX_PLUGIN_ID,
  SIMPLEX_PLUGIN_SPEC,
  requestSimplexPluginUpgrade,
} from './actions/configureSimplex'
import {
  GOOGLE_SIGN_IN_SCRIPT,
  emailEnvAndSkill,
  googleFromVault,
  googleSignInEnv,
  writeHimalayaConfig,
} from './email'
import {
  RBW_ENV,
  RBW_CONFIG,
  RBW_CREDENTIALS,
  RBW_DIR,
  RBW_PINENTRY,
  PINENTRY_SCRIPT,
  VAULT_START_SCRIPT,
  CUSTOM_CA_DIR,
  CUSTOM_CA_PREFIX,
  applyHostsBlock,
  credentialsVolumePath,
  splitPemCerts,
  writeMasterPassword,
} from './vault'
import {
  externalChecks,
  externalTargets,
  type HealthTarget,
  externalTrigger,
  probeHttp,
  probeVault,
  vaultTrigger,
} from './healthChecks'

// Maps each provider's auth-profile id to the env var OpenClaw reads its API
// key from. Keep in sync with MANAGED_PROVIDERS in configureApiCredentials.ts.
const providerKeyEnvVar: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
}

const STATE_MIGRATE_SCRIPT = `
marker=/data/.startos/openclaw-doctor-version
ver=$(openclaw --version 2>/dev/null | awk '{print $2}')
if [ -z "$ver" ]; then echo "state-migrate: could not read the OpenClaw version"; exit 0; fi
if [ "$(cat "$marker" 2>/dev/null)" = "$ver" ]; then exit 0; fi
# A SimpleX plugin older than this OpenClaw can load breaks doctor and every
# plugin-loading CLI command (OpenClaw 2026.10.1 cannot load plugin 2.1.x), so
# upgrade it first. If that fails (no network), doctor fails too and both are
# retried at the next start; Configure SimpleX also asks for a re-submit.
sx=$(openclaw plugins list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{const j=JSON.parse(s);const a=Array.isArray(j)?j:(j.plugins||[]);const e=a.find((p)=>p&&p.id==="${SIMPLEX_PLUGIN_ID}");if(e&&e.version)process.stdout.write(String(e.version))}catch(e){}})')
if [ -n "$sx" ] && [ "$(printf '%s\\n%s\\n' "${MIN_PLUGIN_VERSION}" "$sx" | sort -V | head -n1)" != "${MIN_PLUGIN_VERSION}" ]; then
  echo "state-migrate: upgrading the SimpleX plugin $sx -> ${MIN_PLUGIN_VERSION}"
  if openclaw plugins install ${SIMPLEX_PLUGIN_SPEC} --force --accept-capabilities; then
    echo "state-migrate: SimpleX plugin upgraded"
  else
    echo "state-migrate: SimpleX plugin upgrade failed; retrying at the next start"
  fi
fi
echo "state-migrate: running openclaw doctor --non-interactive once for OpenClaw $ver (1-2 minutes)"
if openclaw doctor --non-interactive; then
  mkdir -p /data/.startos && printf '%s' "$ver" > "$marker"
  echo "state-migrate: done"
  # A new OpenClaw may also need the memory search index rebuilt (2026.9.8
  # paused vector search until it was). Embeddings come from the configured
  # provider; if it is unreachable now, health.py will say so.
  if openclaw memory status --agent main 2>/dev/null | grep -q '^Vector search: paused'; then
    echo "state-migrate: rebuilding the memory search index"
    if openclaw memory status --index --agent main >/dev/null 2>&1; then
      echo "state-migrate: memory index rebuilt"
    else
      echo "state-migrate: memory index not rebuilt: no embedding provider is configured or reachable. Keyword memory search still works. To enable vector search, set Configure AI Provider > Memory Embeddings, then run: openclaw memory status --index --agent main"
    fi
  fi
else
  echo "state-migrate: openclaw doctor failed (exit $?); retrying at the next start"
fi
exit 0
`

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting OpenClaw Gateway!'))

  // Read password for gateway auth (set via critical task during init)
  await openclawJson.read((c) => c.gateway.auth.password).const(effects)

  // Bridge stored provider API keys to the gateway env.
  const profiles =
    (await authProfilesJson.read((p) => p.profiles).const(effects)) ?? {}
  const providerKeyEnv: Record<string, string> = {}
  for (const [provider, varName] of Object.entries(providerKeyEnvVar)) {
    const profile = profiles[`${provider}:default`]
    if (profile?.type === 'token' && profile.token) {
      providerKeyEnv[varName] = profile.token
    }
  }
  // Memory-search embedding key (Configure AI Provider → Memory Embeddings),
  // used only when that provider is not also a chat provider: one key per
  // provider, and the chat key wins.
  const emb = await embeddingsJson.read().const(effects)
  const embVar =
    emb?.provider === 'openai'
      ? 'OPENAI_API_KEY'
      : emb?.provider === 'google'
        ? 'GEMINI_API_KEY'
        : undefined
  if (embVar && emb?.apiKey && !providerKeyEnv[embVar]) {
    providerKeyEnv[embVar] = emb.apiKey
  }

  // Read external services configuration (reactive — main re-runs on change).
  // Services set to "On this server" get their bridge URL here, so everything
  // below (skill env, rbw, health checks) just uses `url`.
  const { ext, missing: missingLocal } = await resolveLocalServices(
    effects,
    await externalServicesJson.read((c) => c).const(effects),
  )

  // Build env vars (non-secret config + vault-lookup markers) and the set of
  // skill dirs to load. Secrets are NOT resolved here — skills call rbw at
  // runtime using the *_FROM_VAULT markers, matching the proven pattern.
  const externalEnv: Record<string, string> = {}
  const enabledSkills: string[] = [
    '/opt/skills/start-cli',
    '/opt/skills/qdrant',
    '/opt/skills/health',
    '/opt/skills/agents',
    '/opt/skills/pdf',
  ]

  const vw = ext?.vaultwarden
  if (vw?.enabled) {
    enabledSkills.push('/opt/skills/rbw')
  }

  if (ext?.ollama?.enabled && ext.ollama.url) {
    externalEnv['OLLAMA_URL'] = ext.ollama.url
    enabledSkills.push('/opt/skills/ollama')
  }

  if (ext?.nas?.enabled) {
    if (ext.nas.host) externalEnv['NAS_HOST'] = ext.nas.host
    // Preferred shares are a hint for the skill, not a restriction: any share
    // the NAS account can open is usable. NAS_SHARE (first entry) is kept for
    // older scripts that expect a single share.
    const shares = (ext.nas.share ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
    if (shares.length) {
      externalEnv['NAS_SHARES'] = shares.join(',')
      externalEnv['NAS_SHARE'] = shares[0]
    }
    const u = ext.nas.username
    if (u?.source === 'manual' && u.value) {
      externalEnv['NAS_USER'] = u.value
    } else if (u?.source === 'from-vaultwarden') {
      externalEnv['NAS_USER_FROM_VAULT'] = 'nas:username'
    }
    const p = ext.nas.password
    if (p?.source === 'manual' && p.value) {
      externalEnv['NAS_PASS'] = p.value
    } else if (p?.source === 'from-vaultwarden') {
      externalEnv['NAS_PASS_FROM_VAULT'] = 'nas:password'
    }
    enabledSkills.push('/opt/skills/nas')
  }

  if (ext?.n8n?.enabled && ext.n8n.url) {
    externalEnv['N8N_URL'] = ext.n8n.url
    const k = ext.n8n.apiKey
    if (k?.source === 'manual' && k.value) {
      externalEnv['N8N_KEY'] = k.value
    } else if (k?.source === 'from-vaultwarden') {
      externalEnv['N8N_KEY_FROM_VAULT'] = 'n8n:api_key'
    }
    enabledSkills.push('/opt/skills/n8n')
  }

  if (ext?.trilium?.enabled && ext.trilium.url) {
    externalEnv['TRILIUM_URL'] = ext.trilium.url
    const k = ext.trilium.apiKey
    if (k?.source === 'manual' && k.value) {
      externalEnv['TRILIUM_KEY'] = k.value
    } else if (k?.source === 'from-vaultwarden') {
      externalEnv['TRILIUM_KEY_FROM_VAULT'] = 'trilium:api_key'
    }
    enabledSkills.push('/opt/skills/trilium')
  }

  if (ext?.searxng?.enabled && ext.searxng.url) {
    externalEnv['SEARXNG_URL'] = ext.searxng.url
    enabledSkills.push('/opt/skills/searxng')
  }

  if (ext?.crawl4ai?.enabled && ext.crawl4ai.url) {
    externalEnv['CRAWL4AI_URL'] = ext.crawl4ai.url
    const k = ext.crawl4ai.apiKey
    if (k?.source === 'manual' && k.value) {
      externalEnv['CRAWL4AI_KEY'] = k.value
    } else if (k?.source === 'from-vaultwarden') {
      externalEnv['CRAWL4AI_KEY_FROM_VAULT'] = 'crawl4ai:api_key'
    }
    enabledSkills.push('/opt/skills/crawl4ai')
  }

  if (ext?.ntfy?.enabled && ext.ntfy.url) {
    externalEnv['NTFY_URL'] = ext.ntfy.url
    if (ext.ntfy.topic) externalEnv['NTFY_TOPIC'] = ext.ntfy.topic
    const k = ext.ntfy.apiKey
    if (k?.source === 'manual' && k.value) {
      externalEnv['NTFY_KEY'] = k.value
    } else if (k?.source === 'from-vaultwarden') {
      externalEnv['NTFY_KEY_FROM_VAULT'] = 'ntfy:api_key'
    }
    enabledSkills.push('/opt/skills/ntfy')
  }

  // Email (Configure External Services → Email): himalaya for the IMAP
  // choices, gog for the Google account. Only one email skill loads.
  const email = await emailEnvAndSkill(ext?.email)
  Object.assign(externalEnv, email.env)
  if (email.skill) enabledSkills.push(email.skill)
  await writeHimalayaConfig(ext?.email)

  // Webchat (Configure Webchat). Reactive: main re-runs when it changes.
  const webchatEnabled =
    (await webchatJson.read((c) => c.enabled).const(effects)) ?? false
  if (webchatEnabled) {
    externalEnv['WEBCHAT_UPLOAD_URL'] = `http://127.0.0.1:${webchatUploadPort}`
    enabledSkills.push('/opt/skills/webchat-present')
  }

  const osIp = await sdk.getOsIp(effects)

  // Ensure required directories exist
  await mkdir(sdk.volumes.main.subpath('.startos'), { recursive: true })
  await mkdir(sdk.volumes.main.subpath('.openclaw/rbw/config/rbw'), {
    recursive: true,
  })
  await mkdir(sdk.volumes.main.subpath('.openclaw/rbw/cache'), {
    recursive: true,
  })
  await mkdir(sdk.volumes.main.subpath('.openclaw/rbw/runtime'), {
    recursive: true,
  })

  await startCliConfigYaml.merge(effects, { host: `https://${osIp}` })

  // Resolve Qdrant's bridge address. Qdrant binds its port to the LXC bridge
  // (interfaces.ts); we read the assigned address here. fallbackPort keeps the
  // value non-null (Qdrant is always present in this package).
  const qdrantAddr = await sdk.host
    .getBridgeAddress(effects, {
      packageId: sdk.manifest.id,
      hostId: qdrantHostId,
      internalPort: qdrantInternalPort,
      ssl: false,
      fallbackPort: qdrantPort,
    })
    .const()
  const qdrantUrl = `http://${qdrantAddr}`

  // What /opt/skills/health/health.py checks: the same targets as the
  // StartOS health list (externalTargets is shared with externalChecks).
  const healthTargets: HealthTarget[] = [
    {
      key: 'gateway',
      label: 'Web Interface',
      kind: 'http',
      url: `http://127.0.0.1:${uiPort}/healthz`,
      okBelow: 300,
    },
    {
      key: 'qdrant',
      label: 'Qdrant',
      kind: 'http',
      url: `${qdrantUrl}/readyz`,
      okBelow: 300,
    },
    ...(webchatEnabled
      ? [
          {
            key: 'webchat',
            label: 'Webchat',
            kind: 'http' as const,
            url: `http://127.0.0.1:${webchatPort}/healthz`,
            okBelow: 300,
          },
        ]
      : []),
    ...(vw?.enabled
      ? [
          missingLocal.vaultwarden
            ? {
                key: 'vault',
                label: 'Vault (rbw)',
                kind: 'missing' as const,
                message: notInstalledMessage(missingLocal.vaultwarden),
              }
            : { key: 'vault', label: 'Vault (rbw)', kind: 'vault' as const },
        ]
      : []),
    ...externalTargets(ext, missingLocal),
  ]

  // Load only the skills for enabled services. OpenClaw's own bundled
  // `himalaya` and `gog` skills stay off: they become eligible now that both
  // programs are in the image, but the bundled himalaya one documents the
  // 1.x CLI (the image has 2.x) and both tell the agent to set up
  // credentials itself. The package's `email` and `google` skills replace
  // them.
  await openclawJson.merge(effects, {
    skills: {
      load: { extraDirs: enabledSkills },
      entries: { himalaya: { enabled: false }, gog: { enabled: false } },
    },
  } as any)

  const bridge = await sdk.host
    .getOwn(effects, uiHostId, (host) => {
      const addresses = Object.values(host?.bindings ?? {})
        .flatMap((b) => Object.values(b.interfaces))
        .find((i) => i.id === uiInterfaceId)
        ?.addressInfo.filter({ kind: 'bridge', predicate: (h) => !h.ssl })
        .filter({ kind: 'ipv4' })
      return {
        url: addresses?.format('urlstring')[0],
        proxies:
          addresses?.format('hostname-info').map((h) => h.hostname) ?? [],
      }
    })
    .const()

  await openclawJson.merge(effects, {
    gateway: { trustedProxies: bridge.proxies },
  })

  const mountIntegrations = [withSimplexMounts]
  let mounts = mainMounts()
  for (const appendMounts of mountIntegrations) {
    mounts = await appendMounts(effects, mounts)
  }

  const addressWatchers = [watchSimplexAddress]
  for (const watch of addressWatchers) {
    await watch(effects)
  }

  const openclawSub = sdk.SubContainer.of(
    effects,
    { imageId: 'openclaw' },
    mounts,
    'openclaw-sub',
  )

  setGatewayContainer(effects, openclawSub)

  const qdrantSub = sdk.SubContainer.of(
    effects,
    { imageId: 'qdrant' },
    qdrantMounts(),
    'qdrant-sub',
  )

  const extChecks = externalChecks(ext, missingLocal)
  const vaultMissing = missingLocal.vaultwarden
  const vaultCheck = vw?.enabled
    ? vaultMissing
      ? {
          display: 'Vault (rbw)',
          fn: async () => ({
            result: 'failure' as const,
            message: notInstalledMessage(vaultMissing),
          }),
        }
      : { display: 'Vault (rbw)', fn: probeVault }
    : {
        display: null,
        fn: async () => ({ result: 'disabled' as const, message: null }),
      }

  // Qdrant readiness: port open, then Qdrant's own /readyz. If the readyz
  // fetch itself can't be made, fall back to the port result so a probe
  // quirk can never hold the gateway (which requires qdrant) hostage.
  const qdrantReady = async () => {
    const port = await sdk.healthCheck.checkPortListening(effects, qdrantPort, {
      successMessage: i18n('Qdrant is ready'),
      errorMessage: i18n('Qdrant is not ready'),
    })
    if (port.result !== 'success') return port
    try {
      const r = await fetch(`${qdrantUrl}/readyz`, {
        signal: AbortSignal.timeout(5_000),
      })
      return r.ok
        ? port
        : {
            result: 'loading' as const,
            message: `Qdrant is starting (readyz HTTP ${r.status})`,
          }
    } catch {
      return port
    }
  }

  const daemons = sdk.Daemons.of(effects)
    .addOneshot('install-root-ca', {
      subcontainer: openclawSub,
      exec: {
        fn: async (subcontainer) => {
          await installRootCA(effects, subcontainer)
          return null
        },
      },
      requires: [],
    })
    .addOneshot('chown', {
      subcontainer: openclawSub,
      exec: {
        command: ['chown', '-R', 'node:node', '/data'],
        user: 'root',
      },
      requires: [],
    })
    // Host mappings (/etc/hosts) and custom CA certs. Independent of
    // Vaultwarden: any internal service may need them. .local names never
    // resolve on StartOS (startd treats them as mDNS), hence /etc/hosts.
    .addOneshot('network-setup', {
      subcontainer: openclawSub,
      exec: {
        fn: async (subcontainer) => {
          try {
            const rootfs = await subcontainer.rootfs
            const hostsPath = `${rootfs}/etc/hosts`
            const existing = await readFile(hostsPath, 'utf-8').catch(
              () => '127.0.0.1\tlocalhost\n',
            )
            const mappings = ext?.hostMappings ?? []
            await subcontainer.writeFile(
              '/etc/hosts',
              applyHostsBlock(existing, mappings),
            )
            console.info(`Wrote ${mappings.length} custom host mapping(s)`)
          } catch (e) {
            console.error('Failed to write /etc/hosts mappings:', e)
          }

          try {
            const certs = splitPemCerts(ext?.caCert)
            await subcontainer.exec(
              ['sh', '-c', `rm -f ${CUSTOM_CA_DIR}/${CUSTOM_CA_PREFIX}*.crt`],
              { user: 'root' },
            )
            for (const [n, pem] of certs.entries()) {
              await subcontainer.writeFile(
                `${CUSTOM_CA_DIR}/${CUSTOM_CA_PREFIX}${n}.crt`,
                pem + '\n',
                { mode: 0o644 },
              )
            }
            const res = await subcontainer.exec(['update-ca-certificates'], {
              user: 'root',
            })
            if (res.exitCode !== 0) {
              console.error(
                'update-ca-certificates failed:',
                String(res.stderr),
              )
            } else {
              console.info(`Installed ${certs.length} custom CA cert(s)`)
            }
          } catch (e) {
            console.error('Failed to install custom CA certificates:', e)
          }
          return null
        },
      },
      requires: ['install-root-ca'],
    })
    // Configure rbw and unlock the vault (proven manual sequence):
    // master password in rbw/.credentials, answered by a file-based
    // pinentry, so login/unlock are non-interactive. Because pinentry is
    // non-interactive, a later `rbw get` from a skill also re-unlocks on
    // its own if the agent died or the lock timeout passed. Never fatal.
    // OpenClaw (since 2026.9.5) does not migrate an older agent database on
    // its own: the gateway starts but refuses sessions until
    // `openclaw doctor` has run with the gateway stopped. Run it once per
    // OpenClaw version, before the gateway; the marker holds the version it
    // last succeeded for. A failure does not block startup (it is retried at
    // the next start).
    .addOneshot('state-migrate', {
      subcontainer: openclawSub,
      exec: {
        command: ['sh', '-c', STATE_MIGRATE_SCRIPT],
        user: 'node',
        env: {
          HOME: '/data',
          OPENCLAW_STATE_DIR: '/data/.openclaw',
          NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
          NO_COLOR: '1',
        },
      },
      requires: ['chown', 'network-setup'],
    })
    .addOneshot('setup-vault', {
      subcontainer: openclawSub,
      exec: {
        fn: async (subcontainer) => {
          if (vw?.enabled && missingLocal.vaultwarden) {
            console.error(
              `${notInstalledMessage(missingLocal.vaultwarden)} Skipping vault setup.`,
            )
            return null
          }
          if (!vw?.enabled || !vw.url || !vw.email) {
            console.info(
              'Vaultwarden not enabled/configured — skipping vault setup',
            )
            return null
          }
          try {
            let haveCreds = await access(credentialsVolumePath)
              .then(() => true)
              .catch(() => false)
            // One-time seed from the legacy settings field (<= :1).
            if (!haveCreds && vw.masterPassword) {
              await writeMasterPassword(vw.masterPassword)
              haveCreds = true
              console.info('Seeded rbw/.credentials from legacy settings')
            }
            if (!haveCreds) {
              console.error(
                'Vaultwarden enabled but no master password saved — enter it in Configure External Services. Skipping vault setup.',
              )
              return null
            }

            await subcontainer.writeFile(RBW_PINENTRY, PINENTRY_SCRIPT, {
              mode: 0o755,
            })
            await subcontainer.writeFile(
              RBW_CONFIG,
              JSON.stringify({
                email: vw.email,
                base_url: vw.url.replace(/\/+$/, ''),
                lock_timeout: 3600,
                pinentry: RBW_PINENTRY,
              }),
              { mode: 0o644 },
            )
            await subcontainer.exec(
              [
                'sh',
                '-c',
                `chown -R node:node ${RBW_DIR} && chmod 600 ${RBW_CREDENTIALS} && chmod 755 ${RBW_PINENTRY}`,
              ],
              { user: 'root' },
            )

            // rbw spawns (and daemonizes) rbw-agent itself; the script
            // stops any stale agent first (see VAULT_START_SCRIPT).
            const res = await subcontainer.exec(
              ['sh', '-c', VAULT_START_SCRIPT],
              {
                user: 'node',
                env: { ...RBW_ENV, VW_URL: vw.url.replace(/\/+$/, '') },
              },
            )
            for (const line of String(res.stdout).split('\n')) {
              if (line.trim()) console.info(line.trim())
            }
            const errText = String(res.stderr).trim()
            if (res.exitCode === 0) {
              if (errText) console.warn(errText)
              console.info('Vault unlocked successfully')
            } else {
              console.error(
                `Vault setup did not unlock (exit ${res.exitCode}): ${errText}`,
              )
            }
          } catch (e) {
            console.error('Vault setup failed (non-fatal):', e)
          }
          return null
        },
      },
      requires: ['install-root-ca', 'chown', 'network-setup'],
    })
    // Google account kept in Vaultwarden: fetch the OAuth client and token
    // and load them into gog before the gateway starts. A no-op for every
    // other email choice. Never fatal (the Google health check says why).
    .addOneshot('google-sign-in', {
      subcontainer: openclawSub,
      exec: {
        command: googleFromVault(ext?.email)
          ? ['sh', '-c', GOOGLE_SIGN_IN_SCRIPT]
          : ['true'],
        user: 'node',
        env: {
          ...RBW_ENV, // includes HOME=/data and a PATH with getcred and gog
          ...(googleFromVault(ext?.email)
            ? {
                ...email.env,
                ...googleSignInEnv(ext!.email!.address!),
              }
            : {}),
        },
      },
      requires: ['chown', 'setup-vault'],
    })
    .addDaemon('qdrant', {
      subcontainer: qdrantSub,
      exec: {
        command: ['./qdrant'],
        user: 'root',
        env: {
          QDRANT__STORAGE__STORAGE_PATH: '/qdrant/storage',
          QDRANT__SERVICE__HTTP_PORT: qdrantPort.toString(),
          QDRANT__LOG_LEVEL: 'INFO',
        },
      },
      ready: {
        display: i18n('Qdrant Vector Database'),
        fn: qdrantReady,
        gracePeriod: 30_000,
      },
      requires: [],
    })
    .addDaemon('primary', {
      subcontainer: openclawSub,
      exec: {
        command: [
          'openclaw',
          'gateway',
          '--port',
          uiPort.toString(),
          '--bind',
          'lan',
          '--allow-unconfigured',
        ],
        user: 'node',
        env: {
          HOME: '/data',
          OPENCLAW_STATE_DIR: '/data/.openclaw',
          NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
          QDRANT_URL: qdrantUrl,
          OPENCLAW_HEALTH_TARGETS: JSON.stringify(healthTargets),
          // rbw XDG paths so skills can call rbw with the unlocked agent
          XDG_CONFIG_HOME: '/data/.openclaw/rbw/config',
          XDG_CACHE_HOME: '/data/.openclaw/rbw/cache',
          XDG_RUNTIME_DIR: '/data/.openclaw/rbw/runtime',
          ...providerKeyEnv,
          ...externalEnv,
        },
      },
      ready: {
        display: i18n('Web Interface'),
        fn: () =>
          bridge.url
            ? sdk.healthCheck.checkWebUrl(effects, `${bridge.url}/healthz`, {
                successMessage: i18n('OpenClaw Gateway is ready'),
                errorMessage: i18n('OpenClaw Gateway is not ready'),
              })
            : Promise.resolve({
                result: 'starting' as const,
                message: i18n('OpenClaw Gateway is not ready'),
              }),
        gracePeriod: 40_000,
      },
      requires: [
        'install-root-ca',
        'chown',
        'state-migrate',
        'network-setup',
        'setup-vault',
        'google-sign-in',
        'qdrant',
      ],
    })
    .addOneshot('check-login', {
      subcontainer: openclawSub,
      exec: {
        fn: async (subcontainer) => {
          const result = await subcontainer.exec(
            ['start-cli', 'auth', 'session', 'list'],
            { user: 'node', env: { HOME: '/data' } },
          )
          if (result.exitCode !== 0) {
            await sdk.action.createOwnTask(effects, loginToOs, 'important', {
              reason: i18n(
                'Login to StartOS to enable start-cli authentication for managing the server',
              ),
            })
          }
          return null
        },
      },
      requires: ['primary'],
    })
    .addOneshot('check-simplex-plugin', {
      subcontainer: openclawSub,
      exec: {
        fn: (subcontainer) =>
          requestSimplexPluginUpgrade(effects, subcontainer),
      },
      requires: ['primary'],
    })
    // Rewrites MEMORY.md's "## Server State Snapshot" section (server state
    // when start-cli is logged in, else this container's health report). The
    // daily heartbeat runs the same script, so the agent never edits it.
    .addOneshot('server-state-snapshot', {
      subcontainer: openclawSub,
      exec: {
        command: ['refresh-snapshot', '--reason', 'startup'],
        user: 'node',
        env: {
          HOME: '/data',
          OPENCLAW_HEALTH_TARGETS: JSON.stringify(healthTargets),
        },
      },
      requires: ['primary', 'check-login'],
    })
    .addHealthCheck('vault', {
      ready: {
        display: vaultCheck.display,
        fn: () => vaultCheck.fn(openclawSub),
        trigger: vaultTrigger,
        gracePeriod: 0,
      },
      requires: ['setup-vault'],
    })
    .addHealthCheck('ext-vaultwarden', {
      ready: {
        display: extChecks.vaultwarden.display,
        fn: () => extChecks.vaultwarden.fn(openclawSub),
        trigger: externalTrigger,
        gracePeriod: 0,
      },
      requires: ['network-setup'],
    })
    .addHealthCheck('ext-ollama', {
      ready: {
        display: extChecks.ollama.display,
        fn: () => extChecks.ollama.fn(openclawSub),
        trigger: externalTrigger,
        gracePeriod: 0,
      },
      requires: ['network-setup'],
    })
    .addHealthCheck('ext-nas', {
      ready: {
        display: extChecks.nas.display,
        fn: () => extChecks.nas.fn(openclawSub),
        trigger: externalTrigger,
        gracePeriod: 0,
      },
      requires: ['network-setup'],
    })
    .addHealthCheck('ext-n8n', {
      ready: {
        display: extChecks.n8n.display,
        fn: () => extChecks.n8n.fn(openclawSub),
        trigger: externalTrigger,
        gracePeriod: 0,
      },
      requires: ['network-setup'],
    })
    .addHealthCheck('ext-trilium', {
      ready: {
        display: extChecks.trilium.display,
        fn: () => extChecks.trilium.fn(openclawSub),
        trigger: externalTrigger,
        gracePeriod: 0,
      },
      requires: ['network-setup'],
    })
    .addHealthCheck('ext-searxng', {
      ready: {
        display: extChecks.searxng.display,
        fn: () => extChecks.searxng.fn(openclawSub),
        trigger: externalTrigger,
        gracePeriod: 0,
      },
      requires: ['network-setup'],
    })
    .addHealthCheck('ext-crawl4ai', {
      ready: {
        display: extChecks.crawl4ai.display,
        fn: () => extChecks.crawl4ai.fn(openclawSub),
        trigger: externalTrigger,
        gracePeriod: 0,
      },
      requires: ['network-setup'],
    })
    .addHealthCheck('ext-ntfy', {
      ready: {
        display: extChecks.ntfy.display,
        fn: () => extChecks.ntfy.fn(openclawSub),
        trigger: externalTrigger,
        gracePeriod: 0,
      },
      requires: ['network-setup'],
    })
    .addHealthCheck('ext-email', {
      ready: {
        display: extChecks.email.display,
        fn: () => extChecks.email.fn(openclawSub),
        trigger: externalTrigger,
        gracePeriod: 0,
      },
      requires: ['network-setup'],
    })

  if (!webchatEnabled) return daemons

  return daemons.addDaemon('webchat', {
    subcontainer: openclawSub,
    exec: {
      command: ['node', '/opt/webchat/server.mjs'],
      user: 'node',
      env: {
        HOME: '/data',
        NODE_ENV: 'production',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
        WEBCHAT_PORT: String(webchatPort),
        WEBCHAT_UPLOAD_PORT: String(webchatUploadPort),
        GW_URL: `ws://127.0.0.1:${uiPort}`,
      },
    },
    ready: {
      display: 'Webchat',
      // /healthz answers 503 while the webchat is up but not yet connected
      // to the gateway, so this goes green only when chatting works.
      fn: () =>
        probeHttp(
          openclawSub,
          'Webchat',
          `http://127.0.0.1:${webchatPort}/healthz`,
          { okBelow: 300 },
        ),
      gracePeriod: 30_000,
    },
    requires: ['primary'],
  })
})
