// kubectl and in-pod curl for cbs_call (D14, D30, A13).
//
// kubectl runs on the laptop against the entity's kube context (the Q26
// default; there is no bastion hop in v1). Three command shapes exist and
// each has a fixed argv:
//
//   kubectl --context C get pods -n NS -l SEL --field-selector=status.phase=Running -o json
//   kubectl --context C get secret NAME -n SECRET_NS -o json
//   kubectl --context C exec -i POD -n NS -c CONTAINER -- curl -sS --max-time N -K -
//
// Every argv value that comes from env is charset-checked first. The request
// URL, headers (the token among them), body and write-out travel to curl as a
// config file on stdin, so the path, body, token and credentials never appear
// in argv, and no shell runs in the pod.
import { assertSafeArg, UnsafeArgError, type ExecResult, type ExecRunner } from '../exec.ts';
import { ConnectorError } from '../types.ts';

export const KUBECTL_BIN = 'kubectl';

/** The env key names each kube value came from. Error messages name these, never the values. */
export type KubeKeyNames = {
  readonly context: string;
  readonly namespace: string;
  readonly selector: string;
  readonly container: string;
};

export type KubeConfig = {
  readonly context: string;
  readonly namespace: string;
  readonly selector: string;
  readonly container: string;
  /** Limit for the kubectl get calls. */
  readonly timeoutMs: number;
  readonly keys: KubeKeyNames;
  /** Defaults to kubectl on PATH. */
  readonly bin?: string;
};

export type SecretRef = {
  readonly namespace: string;
  readonly name: string;
  /** The env key the ref came from. */
  readonly key: string;
};

// Positive charsets on top of assertSafeArg. Contexts can be EKS ARNs
// (arn:aws:eks:region:acct:cluster/name) or user@cluster names.
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,252}$/;
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._/=,-]{0,511}$/;

/**
 * Throws ConnectorError refused unless value passes assertSafeArg and the
 * charset. The message names keyName only.
 */
export function checkEnvArg(value: unknown, keyName: string, charset: RegExp): string {
  try {
    assertSafeArg(value, keyName);
  } catch (err) {
    if (err instanceof UnsafeArgError) throw new ConnectorError('refused', err.message);
    throw err;
  }
  if (!charset.test(value)) {
    throw new ConnectorError('refused', `${keyName} has characters outside its allowed set, so it cannot be passed to kubectl`);
  }
  return value;
}

export type KubeValues = {
  readonly context: unknown;
  readonly namespace: unknown;
  readonly selector: unknown;
  readonly container: unknown;
  readonly timeoutMs: number;
  readonly bin?: string;
};

/** Checks every env-derived kube value and returns a frozen KubeConfig. */
export function checkKubeConfig(values: KubeValues, keys: KubeKeyNames): KubeConfig {
  const cfg: KubeConfig = {
    context: checkEnvArg(values.context, keys.context, CONTEXT),
    namespace: checkEnvArg(values.namespace, keys.namespace, DNS_LABEL),
    selector: checkEnvArg(values.selector, keys.selector, SELECTOR),
    container: checkEnvArg(values.container, keys.container, DNS_LABEL),
    timeoutMs: values.timeoutMs,
    keys: Object.freeze({ ...keys }),
    ...(values.bin !== undefined ? { bin: values.bin } : {}),
  };
  return Object.freeze(cfg);
}

/** Parses '<namespace>/<name>' and checks both parts. */
export function parseSecretRef(value: unknown, keyName: string): SecretRef {
  const raw = checkEnvArg(value, keyName, /^[a-z0-9./-]+$/);
  const parts = raw.split('/');
  if (parts.length !== 2) throw new ConnectorError('refused', `${keyName} must be <namespace>/<name>`);
  const [namespace, name] = parts as [string, string];
  if (!DNS_LABEL.test(namespace) || !DNS_SUBDOMAIN.test(name)) {
    throw new ConnectorError('refused', `${keyName} must be <namespace>/<name> with Kubernetes names`);
  }
  return Object.freeze({ namespace, name, key: keyName });
}

// Re-checks a KubeConfig built elsewhere, so a caller cannot skip checkKubeConfig.
function recheck(k: KubeConfig): void {
  checkEnvArg(k.context, k.keys.context, CONTEXT);
  checkEnvArg(k.namespace, k.keys.namespace, DNS_LABEL);
  checkEnvArg(k.selector, k.keys.selector, SELECTOR);
  checkEnvArg(k.container, k.keys.container, DNS_LABEL);
}

// ------------------------------------------------------------------- argv

export function getPodsArgv(k: KubeConfig): string[] {
  recheck(k);
  return [
    '--context', k.context,
    'get', 'pods',
    '-n', k.namespace,
    '-l', k.selector,
    '--field-selector=status.phase=Running',
    '-o', 'json',
  ];
}

export function getSecretArgv(k: KubeConfig, secret: SecretRef): string[] {
  recheck(k);
  const ref = parseSecretRef(`${secret.namespace}/${secret.name}`, secret.key);
  return ['--context', k.context, 'get', 'secret', ref.name, '-n', ref.namespace, '-o', 'json'];
}

const POD_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

export function execCurlArgv(k: KubeConfig, pod: string, maxTimeSec: number): string[] {
  recheck(k);
  if (!POD_NAME.test(pod)) throw new ConnectorError('refused', 'pod name from kubectl is not a Kubernetes name');
  if (!Number.isInteger(maxTimeSec) || maxTimeSec <= 0) throw new TypeError('cbs: maxTimeSec must be a positive integer');
  return [
    '--context', k.context,
    'exec', '-i', pod,
    '-n', k.namespace,
    '-c', k.container,
    '--', 'curl', '-sS', '--max-time', String(maxTimeSec), '-K', '-',
  ];
}

// ---------------------------------------------------------------- running

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

/** Maps an ExecResult that did not exit 0 to a ConnectorError. Never echoes stderr. */
function failure(r: ExecResult, what: string, signal: AbortSignal): unknown {
  if (r.aborted) return abortError(signal);
  if (r.spawnError !== undefined) return new ConnectorError('unreachable', `kubectl could not be started (${r.spawnError})`);
  if (r.timedOut) return new ConnectorError('timeout', `${what} timed out`);
  if (r.truncated) return new ConnectorError('cap_exceeded', `${what} output passed the size cap`);
  return new ConnectorError('unreachable', `${what} exited with code ${r.exitCode ?? 'none'}`);
}

async function runKubectl(
  exec: ExecRunner,
  k: KubeConfig,
  argv: string[],
  what: string,
  signal: AbortSignal,
  extra: { stdin?: string; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<ExecResult> {
  signal.throwIfAborted();
  const r = await exec.run(k.bin ?? KUBECTL_BIN, argv, {
    timeoutMs: extra.timeoutMs ?? k.timeoutMs,
    signal,
    ...(extra.stdin !== undefined ? { stdin: extra.stdin } : {}),
    ...(extra.maxOutputBytes !== undefined ? { maxOutputBytes: extra.maxOutputBytes } : {}),
  });
  if (r.aborted || signal.aborted) throw abortError(signal);
  return r;
}

type PodList = { items?: unknown };
type PodItem = { metadata?: { name?: unknown; deletionTimestamp?: unknown }; status?: { phase?: unknown } };

/** Runs get pods and returns the first Running pod that is not being deleted. */
export async function resolvePod(exec: ExecRunner, k: KubeConfig, signal: AbortSignal): Promise<string> {
  const r = await runKubectl(exec, k, getPodsArgv(k), 'kubectl get pods', signal);
  if (r.exitCode !== 0 || r.truncated) throw failure(r, 'kubectl get pods', signal);
  let items: unknown;
  try {
    items = (JSON.parse(r.stdout) as PodList).items;
  } catch {
    throw new ConnectorError('unreachable', 'kubectl get pods did not return JSON');
  }
  const list = Array.isArray(items) ? (items as PodItem[]) : [];
  for (const item of list) {
    const name = item?.metadata?.name;
    if (item?.status?.phase !== 'Running' || item.metadata?.deletionTimestamp !== undefined) continue;
    if (typeof name === 'string' && POD_NAME.test(name)) return name;
  }
  throw new ConnectorError(
    'unreachable',
    `no Running pod in the namespace from ${k.keys.namespace} matching the selector from ${k.keys.selector}`,
  );
}

export type Credentials = { readonly username: string; readonly password: string };

export const USERNAME_KEY = 'FINACLE_API_USERNAME';
export const PASSWORD_KEY = 'FINACLE_API_PASSWORD';

function decodeField(data: Record<string, unknown>, field: string, secretKey: string): string {
  const raw = data[field];
  if (typeof raw !== 'string' || raw === '') {
    throw new ConnectorError('not_configured', `the secret from ${secretKey} has no ${field}`);
  }
  const value = Buffer.from(raw, 'base64').toString('utf8');
  if (value === '') throw new ConnectorError('not_configured', `the secret from ${secretKey} has an empty ${field}`);
  return value;
}

/**
 * Reads the Finacle API username and password from the k8s secret. They are
 * held in memory only and returned to the caller; nothing is written.
 */
export async function readCredentials(
  exec: ExecRunner,
  k: KubeConfig,
  secret: SecretRef,
  signal: AbortSignal,
): Promise<Credentials> {
  const r = await runKubectl(exec, k, getSecretArgv(k, secret), 'kubectl get secret', signal);
  if (r.exitCode !== 0 || r.truncated) throw failure(r, 'kubectl get secret', signal);
  let data: unknown;
  try {
    data = (JSON.parse(r.stdout) as { data?: unknown }).data;
  } catch {
    throw new ConnectorError('unreachable', 'kubectl get secret did not return JSON');
  }
  if (typeof data !== 'object' || data === null) {
    throw new ConnectorError('not_configured', `the secret from ${secret.key} has no data`);
  }
  const d = data as Record<string, unknown>;
  return Object.freeze({ username: decodeField(d, USERNAME_KEY, secret.key), password: decodeField(d, PASSWORD_KEY, secret.key) });
}

// ------------------------------------------------------------ curl config

/**
 * Quotes a value for a curl config file (curl -K). Backslash, double quote,
 * tab, newline, carriage return and vertical tab become escapes, so the value
 * stays inside one quoted parameter on one line and cannot start a new
 * directive. Any other control character (NUL, form feed, ...) is refused,
 * since curl's reader does not escape it.
 */
export function curlConfigEscape(value: string): string {
  if (typeof value !== 'string') throw new TypeError('curl config value must be a string');
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '"': out += '\\"'; break;
      case '\t': out += '\\t'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\v': out += '\\v'; break;
      default:
        if (/[\u0000-\u001f\u007f]/.test(ch)) {
          throw new ConnectorError('refused', 'a curl config value holds a control character');
        }
        out += ch;
    }
  }
  return `${out}"`;
}

/** The only curl options a config may carry. */
const CURL_OPTIONS = new Set(['url', 'request', 'header', 'data-raw', 'write-out', 'globoff']);

/** One `name = "value"` line. An option outside the fixed list is refused. */
export function curlConfigLine(option: string, value?: string): string {
  if (!CURL_OPTIONS.has(option)) throw new ConnectorError('refused', 'curl config option is not in the fixed list');
  return value === undefined ? option : `${option} = ${curlConfigEscape(value)}`;
}

export type CurlRequest = {
  readonly url: string;
  readonly method: string;
  /** Name and value pairs. The token goes here as an Authorization header. */
  readonly headers: readonly (readonly [string, string])[];
  /** Sent as is with data-raw, so a leading '@' is not read as a file name. */
  readonly data?: string;
};

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_VALUE = /^[ -~]*$/;
const METHOD = /^[A-Z]{1,10}$/;

/** Marks the status line that write-out appends after the body. */
export const STATUS_MARKER = '\n__triage_cbs_status__:';

export function buildCurlConfig(req: CurlRequest): string {
  if (!METHOD.test(req.method)) throw new ConnectorError('refused', 'curl method must be upper-case letters');
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new ConnectorError('refused', 'curl url is not a URL');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') {
    throw new ConnectorError('refused', 'curl url must be http(s) without credentials');
  }
  const lines = [curlConfigLine('globoff'), curlConfigLine('url', req.url), curlConfigLine('request', req.method)];
  for (const [name, value] of req.headers) {
    if (!HEADER_NAME.test(name)) throw new ConnectorError('refused', 'curl header name has characters outside [A-Za-z0-9-]');
    // A CR or LF would start a new header line on the wire.
    if (!HEADER_VALUE.test(value)) throw new ConnectorError('refused', `curl header ${name} holds a control or non-ASCII character`);
    lines.push(curlConfigLine('header', `${name}: ${value}`));
  }
  if (req.data !== undefined) lines.push(curlConfigLine('data-raw', req.data));
  lines.push(curlConfigLine('write-out', `${STATUS_MARKER}%{http_code}`));
  return `${lines.join('\n')}\n`;
}

export type PodCurlResult = {
  readonly status: number;
  readonly body: string;
};

export type PodCurlOptions = {
  readonly signal: AbortSignal;
  /** curl --max-time in seconds. */
  readonly maxTimeSec: number;
  readonly maxOutputBytes?: number;
};

// curl exit 28 is its own timeout.
const CURL_TIMEOUT_EXIT = 28;

/** Runs curl inside the pod with the request as a config on stdin. */
export async function podCurl(
  exec: ExecRunner,
  k: KubeConfig,
  pod: string,
  req: CurlRequest,
  opts: PodCurlOptions,
): Promise<PodCurlResult> {
  const argv = execCurlArgv(k, pod, opts.maxTimeSec);
  const stdin = buildCurlConfig(req);
  const r = await runKubectl(exec, k, argv, 'curl in the CBS pod', opts.signal, {
    stdin,
    // kubectl exec needs time to attach on top of curl's own limit.
    timeoutMs: opts.maxTimeSec * 1000 + k.timeoutMs,
    ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
  });
  // A cut output has lost the status line at its end, so it cannot be read.
  if (r.truncated) throw new ConnectorError('cap_exceeded', 'the CBS response passed the size cap');
  if (r.exitCode === CURL_TIMEOUT_EXIT) throw new ConnectorError('timeout', 'curl in the CBS pod timed out');
  if (r.exitCode !== 0) throw failure(r, 'curl in the CBS pod', opts.signal);
  const at = r.stdout.lastIndexOf(STATUS_MARKER);
  if (at < 0) throw new ConnectorError('unreachable', 'curl in the CBS pod gave no status code');
  const status = Number(r.stdout.slice(at + STATUS_MARKER.length).trim());
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new ConnectorError('unreachable', 'CBS gave no HTTP response');
  }
  return Object.freeze({ status, body: r.stdout.slice(0, at) });
}
