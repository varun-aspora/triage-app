#!/usr/bin/env python3
"""Read the ticket rows of one tab from an xlsx export of the triage tickets sheet.

Usage: sheet_rows.py <export> [--tab Tech] [--ticket N] [--sort "<column> [asc|desc]"]
                     [--skip-recent 15m] [--max-age 31d] [--exclude "12 34"]

<export> is either the file Claude Code saved for a large Google Drive `download_file_content`
result (JSON: {"content": "<base64 xlsx>", ...}) or a plain .xlsx.

Prints JSON: {"tab", "total", "rows": [{"ticket", "raised_at", "age_minutes", "thread_url", "columns"}]}.
`total` counts the tab's ticket rows before any filter. `raised_at` is "Raised At (IST)" as
ISO 8601 with the IST offset. `thread_url` is the link behind the Thread cell.
Exit 2 for bad arguments or an unreadable export.
"""

import argparse
import base64
import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
PKG = '{http://schemas.openxmlformats.org/package/2006/relationships}'
DATE_FMT_IDS = set(range(14, 23)) | {45, 46, 47}


def fail(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)


def open_xlsx(path):
    raw = open(path, 'rb').read()
    if not raw.startswith(b'PK'):
        try:
            raw = base64.b64decode(json.loads(raw)['content'])
        except (ValueError, KeyError, TypeError):
            fail(f'{path} is neither an xlsx nor a saved download_file_content result')
    return zipfile.ZipFile(io.BytesIO(raw))


def rels(z, path):
    folder, name = path.rsplit('/', 1)
    rel_path = f'{folder}/_rels/{name}.rels'
    if rel_path not in z.namelist():
        return {}
    return {r.get('Id'): r.get('Target') for r in ET.fromstring(z.read(rel_path)).iter(f'{PKG}Relationship')}


def date_styles(z):
    """Indexes of cell styles whose number format is a date or time."""
    if 'xl/styles.xml' not in z.namelist():
        return set()
    root = ET.fromstring(z.read('xl/styles.xml'))
    custom = {int(f.get('numFmtId')): f.get('formatCode', '') for f in root.iterfind('m:numFmts/m:numFmt', NS)}
    dated = {i for i, code in custom.items() if re.search(r'[dmyhs]', re.sub(r'"[^"]*"|\[[^]]*]', '', code), re.I)}
    return {i for i, xf in enumerate(root.iterfind('m:cellXfs/m:xf', NS))
            if int(xf.get('numFmtId', 0)) in DATE_FMT_IDS | dated}


def column(ref):
    return re.match(r'[A-Z]+', ref).group()


def read_tab(z, tab):
    book = ET.fromstring(z.read('xl/workbook.xml'))
    sheet = next((s for s in book.iterfind('m:sheets/m:sheet', NS) if s.get('name').strip() == tab), None)
    if sheet is None:
        names = [s.get('name') for s in book.iterfind('m:sheets/m:sheet', NS)]
        fail(f'no tab {tab!r}; tabs: {", ".join(names)}')
    path = 'xl/' + rels(z, 'xl/workbook.xml')[sheet.get(REL)].lstrip('/').removeprefix('xl/')
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        shared = [''.join(t.text or '' for t in si.iter(f'{{{NS["m"]}}}t'))
                  for si in ET.fromstring(z.read('xl/sharedStrings.xml')).iterfind('m:si', NS)]
    dates = date_styles(z)
    root = ET.fromstring(z.read(path))
    targets = rels(z, path)
    links = {h.get('ref'): targets.get(h.get(REL)) for h in root.iterfind('m:hyperlinks/m:hyperlink', NS)}

    grid = []
    for row in root.iterfind('m:sheetData/m:row', NS):
        cells = {}
        for c in row.iterfind('m:c', NS):
            kind, v = c.get('t'), c.find('m:v', NS)
            if kind == 's' and v is not None:
                text = shared[int(v.text)]
            elif kind == 'inlineStr':
                text = ''.join(t.text or '' for t in c.iter(f'{{{NS["m"]}}}t'))
            elif v is not None and kind in (None, 'n') and int(c.get('s', 0)) in dates:
                d = datetime(1899, 12, 30) + timedelta(days=float(v.text))
                text = d.strftime('%d-%b-%Y %H:%M')
            else:
                text = v.text if v is not None else ''
            cells[column(c.get('r'))] = (text or '', links.get(c.get('r')))
        grid.append(cells)
    return grid


def norm(name):
    return re.sub(r'[^a-z0-9]', '', re.sub(r'\(.*?\)', '', name.lower()))


def parse_ist(text):
    try:
        return datetime.strptime(text.strip(), '%d-%b-%Y %H:%M').replace(tzinfo=IST)
    except (AttributeError, ValueError):
        return None


def sort_key(value):
    """Dates, then numbers ("840 hrs" counts as 840), then text. Empty cells return None."""
    if not value:
        return None
    if (d := parse_ist(value)):
        return (0, d.timestamp(), '')
    if (m := re.match(r'-?\d+(\.\d+)?', value.strip())):
        return (1, float(m.group()), '')
    return (2, 0, value.lower())


def duration(text):
    m = re.fullmatch(r'(\d+)\s*([mhd])', text.strip().lower())
    if not m:
        fail(f'bad duration {text!r}: use a number with m, h or d, e.g. 15m')
    return int(m.group(1)) * {'m': 1, 'h': 60, 'd': 1440}[m.group(2)]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('export')
    p.add_argument('--tab', default='Tech')
    p.add_argument('--ticket')
    p.add_argument('--sort')
    p.add_argument('--skip-recent')
    p.add_argument('--max-age')
    p.add_argument('--exclude', default='')
    a = p.parse_args()

    grid = read_tab(open_xlsx(a.export), a.tab)
    if not grid:
        fail(f'tab {a.tab!r} is empty')
    header = {col: text for col, (text, _) in grid[0].items() if text.strip()}
    by_name = {norm(h): h for h in header.values()}
    first = min(header, key=lambda c: (len(c), c))
    ticket_col, raised_col = header[first], by_name.get('raisedat')

    now = datetime.now(timezone.utc)
    rows = []
    for cells in grid[1:]:
        values = {h: cells.get(col, ('', None))[0] for col, h in header.items()}
        if not values[ticket_col].strip():
            continue
        thread = next((cells.get(col, ('', None))[1] for col, h in header.items() if norm(h) == 'thread'), None)
        raised = parse_ist(values.get(raised_col)) if raised_col else None
        rows.append({
            'ticket': values[ticket_col].strip().removesuffix('.0'),
            'raised_at': raised.isoformat() if raised else None,
            'age_minutes': round((now - raised).total_seconds() / 60) if raised else None,
            'thread_url': thread,
            'columns': values,
        })
    total = len(rows)

    if a.ticket:
        rows = [r for r in rows if r['ticket'] == a.ticket.strip()]
    excluded = set(a.exclude.split())
    rows = [r for r in rows if r['ticket'] not in excluded]
    if a.skip_recent:
        limit = duration(a.skip_recent)
        rows = [r for r in rows if r['age_minutes'] is not None and r['age_minutes'] >= limit]
    if a.max_age:
        limit = duration(a.max_age)
        rows = [r for r in rows if r['age_minutes'] is not None and r['age_minutes'] <= limit]
    if a.sort:
        name, _, direction = a.sort.strip().rpartition(' ')
        if direction.lower() not in ('asc', 'desc'):
            name, direction = a.sort.strip(), 'asc'
        key = norm(name)
        col = ticket_col if key in ('ticket', 'number', 'id') else by_name.get(key)
        if col is None:
            fail(f'no column {name!r}; columns: {", ".join(header.values())}')
        present = [r for r in rows if sort_key(r['columns'][col]) is not None]
        empty = [r for r in rows if sort_key(r['columns'][col]) is None]
        present.sort(key=lambda r: sort_key(r['columns'][col]), reverse=direction.lower() == 'desc')
        rows = present + empty

    print(json.dumps({'tab': a.tab, 'total': total, 'rows': rows}, ensure_ascii=False))


if __name__ == '__main__':
    main()
