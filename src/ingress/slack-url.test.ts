import { describe, expect, test } from 'bun:test';
import { SlackPermalinkError, parseSlackPermalink, pValueToTs } from './slack-url.ts';

function refusal(url: string): SlackPermalinkError {
  try {
    parseSlackPermalink(url);
  } catch (err) {
    if (err instanceof SlackPermalinkError) return err;
    throw err;
  }
  throw new Error('expected a SlackPermalinkError');
}

describe('parseSlackPermalink', () => {
  test('p1695460000123456 -> 1695460000.123456', () => {
    expect(pValueToTs('p1695460000123456')).toBe('1695460000.123456');
    const link = parseSlackPermalink('https://acme.slack.com/archives/C0123ABCD/p1695460000123456');
    expect(link).toEqual({
      channel_id: 'C0123ABCD',
      thread_ts: '1695460000.123456',
      permalink: 'https://acme.slack.com/archives/C0123ABCD/p1695460000123456',
    });
  });

  test('a reply link with thread_ts uses the parent ts, not the reply p value', () => {
    const link = parseSlackPermalink(
      'https://acme.slack.com/archives/C0123ABCD/p1695460999000111?thread_ts=1695460000.123456&cid=C0123ABCD',
    );
    expect(link.thread_ts).toBe('1695460000.123456');
    expect(link.channel_id).toBe('C0123ABCD');
    expect(link.permalink).toBe('https://acme.slack.com/archives/C0123ABCD/p1695460000123456');
  });

  test('the shortest accepted p value has 7 digits', () => {
    expect(parseSlackPermalink('https://slack.com/archives/C0123ABCD/p1234567').thread_ts).toBe('1.234567');
  });

  test('host case and trailing whitespace are normalised', () => {
    const link = parseSlackPermalink(' https://Acme.Slack.com/archives/C0123ABCD/p1695460000123456#frag ');
    expect(link.permalink).toBe('https://acme.slack.com/archives/C0123ABCD/p1695460000123456');
  });

  test('refuses a non-Slack host', () => {
    expect(refusal('https://example.com/archives/C0123ABCD/p1695460000123456').reason).toContain('host');
    expect(refusal('https://slack.com.evil.test/archives/C0123ABCD/p1695460000123456').reason).toContain('host');
    expect(refusal('https://evilslack.com/archives/C0123ABCD/p1695460000123456').reason).toContain('host');
  });

  test('refuses a missing or malformed channel', () => {
    expect(refusal('https://acme.slack.com/archives/').reason).toContain('channel');
    expect(refusal('https://acme.slack.com/archives/p1695460000123456').reason).toContain('channel');
    expect(refusal('https://acme.slack.com/archives/general/p1695460000123456').reason).toContain('channel');
  });

  test('refuses a p value shorter than 7 digits', () => {
    expect(refusal('https://acme.slack.com/archives/C0123ABCD/p123456').reason).toContain('7 digits');
    expect(refusal('https://acme.slack.com/archives/C0123ABCD/p').reason).toContain('7 digits');
    expect(refusal('https://acme.slack.com/archives/C0123ABCD/x1695460000123456').reason).toContain('7 digits');
  });

  test('refuses other malformed links', () => {
    expect(refusal('not a url').reason).toContain('parse');
    expect(refusal('http://acme.slack.com/archives/C0123ABCD/p1695460000123456').reason).toContain('https');
    expect(refusal('https://u:pw@acme.slack.com/archives/C0123ABCD/p1695460000123456').reason).toContain('credentials');
    expect(refusal('https://acme.slack.com/messages/C0123ABCD/p1695460000123456').reason).toContain('/archives/');
    expect(refusal('https://acme.slack.com/archives/C0123ABCD').reason).toContain('missing');
    expect(refusal('https://acme.slack.com/archives/C0123ABCD/p1695460000123456/x').reason).toContain('extra');
    expect(refusal('https://acme.slack.com/archives/C0123ABCD/p1695460000123456?thread_ts=abc').reason).toContain('thread_ts');
  });

  test('refusal messages do not echo the URL', () => {
    const err = refusal('https://example.com/archives/C0123ABCD/p1695460000123456');
    expect(err.message).not.toContain('example.com');
    expect(err.message).not.toContain('1695460000123456');
  });
});
