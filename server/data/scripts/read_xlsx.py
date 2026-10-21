#!/usr/bin/env python3
"""Tiny xlsx reader (stdlib only): dump first sheet to TSV. usage: read_xlsx.py in.xlsx out.tsv"""
import sys, zipfile, re, xml.etree.ElementTree as ET
ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
z = zipfile.ZipFile(sys.argv[1])
ss = []
if 'xl/sharedStrings.xml' in z.namelist():
    for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', ns):
        ss.append(''.join(t.text or '' for t in si.iter('{%s}t' % ns['m'])))
sheet = sorted(n for n in z.namelist() if n.startswith('xl/worksheets/sheet'))[0]
def col(ref): 
    c = re.match(r'[A-Z]+', ref).group(); n = 0
    for ch in c: n = n * 26 + ord(ch) - 64
    return n - 1
with open(sys.argv[2], 'w', encoding='utf8') as out:
    for ev, row in ET.iterparse(z.open(sheet)):
        if row.tag != '{%s}row' % ns['m']: continue
        cells = {}
        for c in row.findall('m:c', ns):
            v = c.find('m:v', ns)
            if v is None:
                t = c.find('m:is', ns); val = ''.join(x.text or '' for x in t.iter('{%s}t' % ns['m'])) if t is not None else ''
            else: val = ss[int(v.text)] if c.get('t') == 's' else v.text
            cells[col(c.get('r'))] = val
        out.write('\t'.join(cells.get(i, '') for i in range(max(cells) + 1) if True) + '\n' if cells else '\n')
        row.clear()
