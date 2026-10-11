import { sdk } from '../sdk'
import { DOCTOR_TIMEOUT_MS, runOpenclawCli } from '../utils'
import { i18n } from '../i18n'

const { InputSpec, Value, Variants } = sdk

const MAX_OUTPUT_CHARS = 100_000

function trimOutput(raw: string): string {
  const text = raw.trim()
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `[…truncated, showing the last ${MAX_OUTPUT_CHARS} characters]\n${text.slice(
    -MAX_OUTPUT_CHARS,
  )}`
}

// doctor's report modes print one line of JSON. Show its findings as readable
// lines, followed by the JSON itself (indented); any other output is shown as is.
function readable(stdout: string): string {
  let parsed: any
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return stdout
  }
  const pretty = JSON.stringify(parsed, null, 2)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray(parsed.findings)
  ) {
    return pretty
  }
  const head = [
    parsed.ok === true ? 'ok' : parsed.ok === false ? 'problems found' : null,
    typeof parsed.checksRun === 'number'
      ? `${parsed.checksRun} checks run`
      : null,
    typeof parsed.checksSkipped === 'number'
      ? `${parsed.checksSkipped} skipped`
      : null,
  ]
    .filter(Boolean)
    .join(', ')
  const lines = parsed.findings.map((f: any) => {
    const where = f.path ? ` (${f.path})` : ''
    const fix = f.fixHint
      ? `\n    fix: ${String(f.fixHint).replace(/\n/g, '\n         ')}`
      : ''
    return `[${f.severity ?? 'note'}] ${f.message ?? f.checkId ?? ''}${where}${fix}`
  })
  return [head, ...lines, '', '--- full JSON ---', pretty].join('\n')
}

export const repairOpenclaw = sdk.Action.withInput(
  'repair-openclaw',

  async () => ({
    name: i18n('Repair OpenClaw'),
    description: i18n(
      'Run one of OpenClaw’s maintenance commands against the stopped service.',
    ),
    warning: i18n('Back up the service before applying repairs.'),
    allowedStatuses: 'only-stopped',
    group: null,
    visibility: 'enabled',
  }),

  InputSpec.of({
    command: Value.union({
      name: i18n('Command'),
      description: null,
      default: 'repair',
      variants: Variants.of({
        repair: {
          name: i18n('Repair config and database (doctor --fix)'),
          spec: InputSpec.of({
            apply: Value.toggle({
              name: i18n('Apply recommended repairs'),
              description: i18n('If not checked, no changes will be made.'),
              default: false,
            }),
          }),
        },
        sessions: {
          name: i18n('Import sessions to SQLite (doctor --session-sqlite)'),
          spec: InputSpec.of({
            apply: Value.toggle({
              name: i18n('Apply changes'),
              description: i18n('If not checked, no changes will be made.'),
              default: false,
            }),
          }),
        },
      }),
    }),
  }),

  async () => ({ command: { selection: 'repair' as const, value: {} } }),

  async ({ effects, input }) => {
    // Bare `doctor` still migrates state; only `--lint` (and `--json`) is read-only.
    const args =
      input.command.selection === 'sessions'
        ? [
            'doctor',
            '--session-sqlite',
            input.command.value.apply ? 'import' : 'dry-run',
            '--session-sqlite-all-agents',
          ]
        : input.command.value.apply
          ? ['doctor', '--fix', '--non-interactive']
          : ['doctor', '--lint']

    const result = await runOpenclawCli(
      effects,
      'openclaw-doctor',
      args,
      DOCTOR_TIMEOUT_MS,
    )

    const stdout = String(result.stdout ?? '').trim()
    const stderr = String(result.stderr ?? '').trim()
    const combined = [readable(stdout), stderr && `[stderr]\n${stderr}`]
      .filter(Boolean)
      .join('\n\n')

    return {
      version: '1',
      title: i18n('Maintenance Result'),
      message: `openclaw ${args.join(' ')} — ${i18n('Exit Code')}: ${result.exitCode ?? result.exitSignal}`,
      result: {
        type: 'multiline',
        name: i18n('Output'),
        description: null,
        value: trimOutput(combined) || i18n('No output'),
        copyable: true,
        filename: 'openclaw-repair-output.txt',
      },
    }
  },
)
