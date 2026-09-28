#!/usr/bin/env python3
"""Parse a Slack thread link into the channel and the parent message ts.

Usage: slack_ref.py <slack-url>

Prints JSON: {"channel", "thread_ts", "posted_at", "age_days"}.
A link to a reply carries ?thread_ts=<parent>; that parent is used.
Exit 2 when the link is not a Slack message link.
"""

import json
import re
import sys
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

url = sys.argv[1] if len(sys.argv) > 1 else ''
u = urlparse(url.strip())
m = re.search(r'/archives/([A-Z0-9]+)/p(\d{10})(\d{6})', u.path)
if not m:
    sys.exit(f'not a Slack message link: {url!r}')

channel = m.group(1)
ts = f'{m.group(2)}.{m.group(3)}'
ts = parse_qs(u.query).get('thread_ts', [ts])[0]

posted = datetime.fromtimestamp(float(ts), tz=timezone.utc)
age = (datetime.now(timezone.utc) - posted).total_seconds() / 86400
print(json.dumps({'channel': channel, 'thread_ts': ts, 'posted_at': posted.isoformat(), 'age_days': round(age, 1)}))
