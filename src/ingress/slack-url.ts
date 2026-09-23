// Slack permalink parsing (LLD 04 §2.1). Pure: no network, no config.
//
// A permalink looks like https://<workspace>.slack.com/archives/<channel>/p<digits>.
// The p value is the message ts with the dot removed; the dot goes back in
// 6 digits from the right. A link to a reply also carries ?thread_ts=<parent ts>,
// and that parent ts wins, because the run is about the whole thread.

export type SlackPermalink = {
  readonly channel_id: string;
  readonly thread_ts: string;
  /** Canonical permalink of the thread parent, without query or fragment. */
  readonly permalink: string;
};

/** Refusal for a URL that is not a usable Slack thread permalink. Never echoes the URL. */
export class SlackPermalinkError extends Error {
  override readonly name = 'SlackPermalinkError';
  readonly reason: string;

  constructor(reason: string) {
    super(`not a Slack thread permalink: ${reason}`);
    this.reason = reason;
  }
}

const CHANNEL_RE = /^[CDG][A-Z0-9]{6,20}$/;
const P_VALUE_RE = /^p(\d{7,20})$/;
const THREAD_TS_RE = /^\d{1,14}\.\d{6}$/;

function isSlackHost(host: string): boolean {
  return host === 'slack.com' || host.endsWith('.slack.com');
}

/** Turns p1695460000123456 into 1695460000.123456. */
export function pValueToTs(p: string): string {
  const m = P_VALUE_RE.exec(p);
  if (m === null) throw new SlackPermalinkError('the message part must be p followed by at least 7 digits');
  const digits = m[1] as string;
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

export function parseSlackPermalink(url: string): SlackPermalink {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new SlackPermalinkError('the URL does not parse');
  }
  if (parsed.protocol !== 'https:') throw new SlackPermalinkError('the URL must use https');
  if (parsed.username !== '' || parsed.password !== '') throw new SlackPermalinkError('the URL must not carry credentials');
  const host = parsed.hostname.toLowerCase();
  if (!isSlackHost(host)) throw new SlackPermalinkError('the host is not slack.com');

  const parts = parsed.pathname.split('/').filter((s) => s !== '');
  if (parts[0] !== 'archives') throw new SlackPermalinkError('the path must start with /archives/');
  const channel = parts[1];
  if (channel === undefined || !CHANNEL_RE.test(channel)) throw new SlackPermalinkError('the channel id is missing or malformed');
  const p = parts[2];
  if (p === undefined) throw new SlackPermalinkError('the message part is missing');
  if (parts.length > 3) throw new SlackPermalinkError('the path has extra segments');
  const messageTs = pValueToTs(p);

  const threadParam = parsed.searchParams.get('thread_ts');
  let threadTs = messageTs;
  if (threadParam !== null) {
    if (!THREAD_TS_RE.test(threadParam)) throw new SlackPermalinkError('the thread_ts query is malformed');
    threadTs = threadParam;
  }

  const permalink = `https://${host}/archives/${channel}/p${threadTs.replace('.', '')}`;
  return Object.freeze({ channel_id: channel, thread_ts: threadTs, permalink });
}
