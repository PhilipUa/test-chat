/**
 * A load-driven autoscaler for the api service.
 *
 * Compose has no autoscaler — `--scale N` is a number a human types — so this is the missing control loop:
 * sample every replica, decide, run `compose up --scale`, wait out a cooldown, repeat. The decision is
 * `autoscale-policy.mjs` and is unit tested; everything here is the I/O around it.
 *
 * What to scale on is configuration, not a decision baked into the code: see `autoscale.config.json`, and
 * the header of autoscale-policy.mjs for what each signal means and why `connections` is the default for
 * this app rather than CPU.
 *
 *   node scripts/autoscale.mjs --dry-run                    # decide and log, change nothing
 *   node scripts/autoscale.mjs --once                        # a single tick
 *   node scripts/autoscale.mjs                               # run until Ctrl-C
 *   node scripts/autoscale.mjs --config my-rules.json        # a different rule set
 *   node scripts/autoscale.mjs --signal cpu --up 70 --down 20 --aggregate max
 *   node scripts/autoscale.mjs --signal memory --up 400 --down 150
 *   node scripts/autoscale.mjs --min 2 --max 8 --interval 10 --cooldown 30
 *
 * `--signal` replaces the configured rules with a single one, which is the quickest way to try a different
 * signal without editing the file. For more than one rule at a time, use the config.
 *
 * ## What this is and is not
 *
 * It is a real control loop, and honest about being a demonstration of one. It runs on the host because
 * scaling Compose needs the docker CLI, and the alternative — a container with `/var/run/docker.sock`
 * mounted — hands root-equivalent access to anything that can reach that container. That trade is not worth
 * making for a demo, and in production the answer is not this script at all: it is a Kubernetes HPA (or
 * equivalent) scaling a Deployment, where the scaling authority already exists and is scoped. What
 * transfers is the choice of signal and the anti-flap rule, not the plumbing.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { decideScale, validateRules } from './autoscale-policy.mjs';

const BASE = process.env.RELAY_URL || 'http://localhost:3000';

const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const numberOf = (name) => (argOf(name) === undefined ? undefined : Number(argOf(name)));
const has = (name) => process.argv.includes(`--${name}`);

if (has('help')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?|^ \* ?/gm, ''));
  process.exit(0);
}

/* ------------------------------------------------------------------ configuration */

const configPath = argOf('config') ?? 'autoscale.config.json';
let fileConfig = {};
try {
  fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (err) {
  if (argOf('config')) {
    console.error(`could not read --config ${configPath}: ${err.message}`);
    process.exit(2);
  }
  // No file and none asked for: fall through to the built-in defaults below.
}

// `--signal` collapses the rule set to one, for trying a signal without editing the file. Anything the
// flag doesn't mention keeps the config's value for that signal, or a sensible default.
const RULE_DEFAULTS = {
  connections: { up: 2, down: 1 },
  cpu: { up: 70, down: 20, aggregate: 'max' },
  memory: { up: 400, down: 150, proportional: false },
};

function resolveRules() {
  const signal = argOf('signal');
  if (!signal) {
    const rules = fileConfig.rules ?? [{ signal: 'connections', ...RULE_DEFAULTS.connections }];
    // A flag alongside a multi-rule config would be ambiguous about which rule it meant, so say so rather
    // than guessing.
    if ((numberOf('up') !== undefined || numberOf('down') !== undefined) && rules.length > 1) {
      console.error('--up/--down with more than one configured rule is ambiguous; use --signal too');
      process.exit(2);
    }
    return rules.map((rule) => ({
      ...rule,
      up: numberOf('up') ?? rule.up,
      down: numberOf('down') ?? rule.down,
      aggregate: argOf('aggregate') ?? rule.aggregate,
    }));
  }

  const fromFile = (fileConfig.rules ?? []).find((r) => r.signal === signal) ?? {};
  const defaults = RULE_DEFAULTS[signal] ?? {};
  return [
    {
      signal,
      ...defaults,
      ...fromFile,
      ...(numberOf('up') === undefined ? {} : { up: numberOf('up') }),
      ...(numberOf('down') === undefined ? {} : { down: numberOf('down') }),
      ...(argOf('aggregate') === undefined ? {} : { aggregate: argOf('aggregate') }),
    },
  ];
}

const config = {
  min: numberOf('min') ?? fileConfig.min ?? 2,
  max: numberOf('max') ?? fileConfig.max ?? 6,
  intervalMs: (numberOf('interval') ?? fileConfig.intervalSeconds ?? 10) * 1000,
  cooldownMs: (numberOf('cooldown') ?? fileConfig.cooldownSeconds ?? 30) * 1000,
  rules: resolveRules(),
};

// Refuse to start on a bad rule set. A scaler that dies on its first tick is easy to mistake for one
// that is quietly running and deciding nothing.
const problems = validateRules(config.rules);
if (problems.length) {
  console.error(`autoscaling config is not usable (${configPath}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(2);
}

const dryRun = has('dry-run');
const once = has('once');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

const sh = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/* ---------------------------------------------------------------------- sampling */

/**
 * One metrics reading per replica.
 *
 * Replicas are not individually addressable from the host, so this samples through the proxy until it
 * stops finding new instance ids — round-robin gets to all of them. Each reports its own connection count,
 * CPU and memory, and `X-Relay-Instance` is what makes the samples attributable.
 */
async function sampleMetrics(samples = 24) {
  const byInstance = new Map();
  for (let i = 0; i < samples; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      const instance = res.headers.get('x-relay-instance');
      const body = await res.json();
      if (instance) {
        byInstance.set(instance, {
          connections: body.connections ?? 0,
          cpuPercent: body.cpuPercent ?? 0,
          memoryMb: body.memoryMb ?? 0,
        });
      }
    } catch {
      // A replica mid-restart refusing a connection is expected; the sample just misses it.
    }
  }
  return byInstance;
}

const scaleTo = (n) => sh('docker', ['compose', 'up', '-d', '--no-deps', '--scale', `api=${n}`, 'api']);

/** One line per replica, in the units of whichever signals are configured. */
function describeReplicas(byInstance) {
  const wanted = new Set(config.rules.map((r) => r.signal));
  return [...byInstance.entries()]
    .map(([id, m]) => {
      const parts = [];
      if (wanted.has('connections')) parts.push(`${m.connections} conn`);
      if (wanted.has('cpu')) parts.push(`${m.cpuPercent.toFixed(1)}% cpu`);
      if (wanted.has('memory')) parts.push(`${m.memoryMb}MB`);
      return `${id}=${parts.join('/')}`;
    })
    .join('  ');
}

/* -------------------------------------------------------------------------- loop */

let cooldownUntil = 0;

async function tick() {
  const byInstance = await sampleMetrics();
  const metrics = [...byInstance.values()];

  const decision = decideScale({
    replicas: byInstance.size,
    metrics,
    rules: config.rules,
    min: config.min,
    max: config.max,
    cooldownRemainingMs: Math.max(0, cooldownUntil - Date.now()),
  });

  const detail = describeReplicas(byInstance);
  if (decision.target === byInstance.size) {
    log(`hold at ${byInstance.size} — ${decision.reason}`);
    if (detail) log(`  ${detail}`);
    return;
  }

  const direction = decision.target > byInstance.size ? 'up' : 'down';
  log(`scale ${direction}: ${byInstance.size} → ${decision.target} — ${decision.reason}`);
  if (detail) log(`  ${detail}`);

  if (dryRun) {
    log('  --dry-run, so not touching the stack');
    return;
  }

  try {
    scaleTo(decision.target);
    // The cooldown starts when the change is issued, not when it converges: the discovery window is part
    // of what we are waiting out.
    cooldownUntil = Date.now() + config.cooldownMs;
    log(`  scaled; cooling down for ${config.cooldownMs / 1000}s`);
  } catch (err) {
    log(`  scaling failed: ${err.message.split('\n')[0]}`);
  }
}

const ruleSummary = config.rules
  .map((r) => `${r.aggregate ?? 'mean'} ${r.signal} up>${r.up} down<${r.down}`)
  .join(', ');
log(
  `autoscaler watching ${BASE} — min=${config.min} max=${config.max}, ` +
    `every ${config.intervalMs / 1000}s, cooldown ${config.cooldownMs / 1000}s` +
    (dryRun ? ' (dry run)' : ''),
);
log(`  rules: ${ruleSummary}${argOf('config') || fileConfig.rules ? ` (from ${configPath})` : ' (built-in defaults)'}`);

if (once) {
  await tick();
} else {
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
    log('stopping (the stack is left at whatever it was last scaled to)');
  });
  while (!stopping) {
    await tick();
    await sleep(config.intervalMs);
  }
}
