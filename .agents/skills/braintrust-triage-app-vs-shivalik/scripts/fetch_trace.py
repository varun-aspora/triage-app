#!/usr/bin/env python3
"""Fetch one Braintrust trace with the `bt` CLI and write a compact view of it.

Usage:
  fetch_trace.py --project <name> --span-id <id> --out <dir> [--label app] [--nearby 120]

Any span id in the trace works (root or child). Writes to <out>:
  raw.json       every span row, full content (read spans from here when you need detail)
  timeline.md    one line per span in tree order, with short input/output previews
  summary.json   totals: spans, tools, errors, tokens, cost, wall time, models, root input/output
  nearby.json    other traces in the same project that started while this one ran
                 (triage-app logs decision-model and embedding calls as separate traces)

Exit codes: 0 ok, 2 project or span not found, 3 bt failed.
"""

import argparse
import json
import os
import subprocess
import sys
from collections import Counter, defaultdict


def bt(args):
    try:
        p = subprocess.run(['bt', *args], capture_output=True, text=True)
    except FileNotFoundError:
        sys.exit('bt CLI not found. Install it or fetch the trace through the Braintrust MCP server instead.')
    if p.returncode != 0:
        print(f'bt {" ".join(args[:2])} failed: {p.stderr.strip() or p.stdout.strip()}', file=sys.stderr)
        sys.exit(3)
    return json.loads(p.stdout)


def sql(query):
    return bt(['sql', '--json', '--non-interactive', query])['data']


def project_id(name):
    d = bt(['projects', 'list', '--json'])
    items = d if isinstance(d, list) else d.get('items', [])
    for p in items:
        if p.get('name') == name or p.get('id') == name:
            return p['id']
    print(f'Braintrust project "{name}" not found. Projects: {[p.get("name") for p in items]}', file=sys.stderr)
    sys.exit(2)


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def clip(s, n):
    s = ' '.join(str(s).split())
    return s if len(s) <= n else s[:n] + f'… [{len(s)} chars]'


def render(x, n):
    """Short text for a span input or output, whatever shape it has."""
    if x is None:
        return ''
    if isinstance(x, str):
        return clip(x, n)
    if isinstance(x, list) and x and isinstance(x[0], dict) and 'role' in x[0]:
        # A message list: show only the last message, the earlier ones repeat previous turns.
        return f'[{len(x)} msgs] last {x[-1].get("role")}: ' + render_message(x[-1], n)
    if isinstance(x, dict) and 'role' in x:
        return render_message(x, n)
    return clip(json.dumps(x, ensure_ascii=False, default=str), n)


def render_message(m, n):
    parts = []
    content = m.get('content')
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for c in content:
            if not isinstance(c, dict):
                parts.append(str(c))
            elif c.get('type') == 'text':
                parts.append(c.get('text', ''))
            elif c.get('type') == 'thinking':
                parts.append('[thinking] ' + str(c.get('thinking', '')))
            elif c.get('type') in ('toolCall', 'tool_use'):
                parts.append(f'[call {c.get("name")}] ' + json.dumps(c.get('arguments', c.get('input')), default=str))
            elif c.get('type') in ('toolResult', 'tool_result'):
                parts.append('[result] ' + json.dumps(c.get('content'), default=str))
            else:
                parts.append(json.dumps(c, default=str))
    for tc in m.get('tool_calls') or []:
        f = tc.get('function', {})
        parts.append(f'[call {f.get("name")}] {f.get("arguments")}')
    return clip(' | '.join(p for p in parts if p), n)


def distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def near_matches(pid, wanted):
    """Root traces whose id is a typo away from, or starts with, the id asked for."""
    roots = sql(f'SELECT root_span_id, created FROM project_logs({q(pid)}) WHERE is_root = true LIMIT 1000')
    w = wanted.lower()
    return [f'{r["root_span_id"]} (started {r["created"]})' for r in roots
            if r['root_span_id'].startswith(w) or distance(r['root_span_id'], w) <= 2][:5]


def fetch_trace(pid, root):
    rows, last = [], None
    while True:  # Braintrust caps LIMIT at 1000, so page on _pagination_key.
        after = f' AND _pagination_key > {q(last)}' if last else ''
        page = sql(f'SELECT * FROM project_logs({q(pid)}) WHERE root_span_id = {q(root)}{after} '
                   f'ORDER BY _pagination_key ASC LIMIT 1000')
        rows += page
        if len(page) < 1000:
            break
        last = page[-1]['_pagination_key']
    count = sql(f'SELECT count(*) AS n FROM project_logs({q(pid)}) WHERE root_span_id = {q(root)}')[0]['n']
    return rows, count


def tree_order(rows):
    by_id = {r['span_id']: r for r in rows}
    kids = defaultdict(list)
    tops = []
    for r in rows:
        parent = (r.get('span_parents') or [None])[0]
        (kids[parent] if parent in by_id else tops).append(r)
    start = lambda r: (r.get('metrics') or {}).get('start') or 0
    out = []

    def walk(r, depth):
        out.append((depth, r))
        for c in sorted(kids[r['span_id']], key=start):
            walk(c, depth + 1)

    for t in sorted(tops, key=start):
        walk(t, 0)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project', required=True)
    ap.add_argument('--span-id', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--label', default='trace')
    ap.add_argument('--preview', type=int, default=300, help='characters per input/output preview')
    ap.add_argument('--nearby', type=int, default=120, help='seconds around the trace to look for other traces; 0 to skip')
    a = ap.parse_args()

    pid = project_id(a.project)
    hit = sql(
        f'SELECT root_span_id FROM project_logs({q(pid)}) '
        f'WHERE span_id = {q(a.span_id)} OR root_span_id = {q(a.span_id)} OR id = {q(a.span_id)} LIMIT 1'
    )
    if not hit:
        print(f'Span "{a.span_id}" not found in project "{a.project}" ({pid}).', file=sys.stderr)
        close = near_matches(pid, a.span_id)
        if close:
            print('Close matches (not used; confirm with the user first):', file=sys.stderr)
            for c in close:
                print(f'  {c}', file=sys.stderr)
        sys.exit(2)
    root = hit[0]['root_span_id']
    rows, count = fetch_trace(pid, root)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'raw.json'), 'w') as f:
        json.dump(rows, f, ensure_ascii=False, default=str)

    m = lambda r, k: (r.get('metrics') or {}).get(k)
    starts = [m(r, 'start') for r in rows if m(r, 'start')]
    ends = [m(r, 'end') for r in rows if m(r, 'end')]
    t0 = min(starts) if starts else 0

    lines = [f'# {a.label} trace {root} ({a.project})', '',
             'idx | +s | dur s | type | name | span | tok in/out | notes', '']
    for i, (depth, r) in enumerate(tree_order(rows)):
        sa = r.get('span_attributes') or {}
        dur = (m(r, 'end') - m(r, 'start')) if m(r, 'end') and m(r, 'start') else None
        tok = f'{m(r, "prompt_tokens") or ""}/{m(r, "completion_tokens") or ""}'.strip('/')
        err = f' ERROR: {clip(r["error"], 200)}' if r.get('error') else ''
        head = (f'{i:03d} {"  " * depth}+{(m(r, "start") or t0) - t0:.0f}s {dur:.1f}s ' if dur is not None
                else f'{i:03d} {"  " * depth}+?s ?s ')
        lines.append(f'{head}[{sa.get("type")}] {sa.get("name")} ({r["span_id"]}) {tok}{err}')
        if r.get('input') is not None:
            lines.append(f'{"  " * depth}      in:  {render(r.get("input"), a.preview)}')
        if r.get('output') is not None:
            lines.append(f'{"  " * depth}      out: {render(r.get("output"), a.preview)}')
    with open(os.path.join(a.out, 'timeline.md'), 'w') as f:
        f.write('\n'.join(lines) + '\n')

    md = lambda r: r.get('metadata') or {}
    root_row = next((r for r in rows if r['span_id'] == root), None)
    names = Counter((r.get('span_attributes') or {}).get('name') for r in rows)
    summary = {
        'label': a.label, 'project': a.project, 'project_id': pid,
        'requested_span_id': a.span_id, 'root_span_id': root,
        'spans_fetched': len(rows), 'spans_in_braintrust': count, 'complete': len(rows) == count,
        'wall_time_s': round(m(root_row, 'end') - m(root_row, 'start'), 1)
        if root_row and m(root_row, 'end') and m(root_row, 'start') else None,
        'span_range_s': round(max(ends) - min(starts), 1) if starts and ends else None,
        'span_types': Counter((r.get('span_attributes') or {}).get('type') for r in rows),
        'span_names': dict(names.most_common(40)),
        'errors': [{'span_id': r['span_id'], 'name': (r.get('span_attributes') or {}).get('name'),
                    'error': clip(r['error'], 300)} for r in rows if r.get('error')],
        'models': Counter(md(r).get('flue.model') or md(r).get('model') for r in rows
                          if (r.get('span_attributes') or {}).get('type') == 'llm'),
        'prompt_tokens': sum(m(r, 'prompt_tokens') or 0 for r in rows),
        'completion_tokens': sum(m(r, 'completion_tokens') or 0 for r in rows),
        'cached_tokens': sum(m(r, 'prompt_cached_tokens') or 0 for r in rows),
        'estimated_cost_usd': round(sum(m(r, 'estimated_cost') or 0 for r in rows), 4),
        'cost_missing_on_llm_spans': sum(1 for r in rows if (r.get('span_attributes') or {}).get('type') == 'llm'
                                         and m(r, 'estimated_cost') is None),
        'root_input': root_row.get('input') if root_row else None,
        'root_output': root_row.get('output') if root_row else None,
    }
    with open(os.path.join(a.out, 'summary.json'), 'w') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2, default=str)

    nearby = []
    if a.nearby and starts:
        # created is an ISO timestamp; metrics.start is epoch seconds.
        side = sql(
            f'SELECT root_span_id, span_id, span_attributes, metadata, metrics, input, output, error '
            f'FROM project_logs({q(pid)}) WHERE is_root = true AND root_span_id != {q(root)} '
            f'AND metrics.start >= {min(starts) - a.nearby} AND metrics.start <= {max(ends) + a.nearby} LIMIT 100'
        )
        nearby = [{'root_span_id': r['root_span_id'], 'name': (r.get('span_attributes') or {}).get('name'),
                   'type': (r.get('span_attributes') or {}).get('type'), 'metadata': r.get('metadata'),
                   'start_offset_s': round(m(r, 'start') - t0, 1) if m(r, 'start') else None,
                   'prompt_tokens': m(r, 'prompt_tokens'), 'estimated_cost': m(r, 'estimated_cost'),
                   'input': render(r.get('input'), a.preview), 'output': render(r.get('output'), a.preview),
                   'error': r.get('error')} for r in side]
    with open(os.path.join(a.out, 'nearby.json'), 'w') as f:
        json.dump(nearby, f, ensure_ascii=False, indent=2, default=str)

    print(json.dumps({k: summary[k] for k in ('label', 'root_span_id', 'spans_fetched', 'complete', 'wall_time_s',
                                              'prompt_tokens', 'completion_tokens', 'estimated_cost_usd')}
                     | {'errors': len(summary['errors']), 'nearby_traces': len(nearby), 'out': a.out}))


if __name__ == '__main__':
    main()
