#!/usr/bin/env python3
"""Sanity check: where do Nation's BNC/COCA headwords (1st..10th 1000, public PDFs) fall in our lemma ranks?
Nation's lists are NOT redistributed; used only to check that our bands are comparable. usage: validate_vs_nation.py en-freq.tsv nat_dir"""
import sys, re, subprocess, statistics
rank = {}
for l in open(sys.argv[1], encoding='utf8').read().split('\n')[1:]:
    if l: w, r = l.split('\t'); rank[w] = int(r)
names = 'first second third fourth fifth sixth seventh eighth ninth tenth'.split()
for k, n in enumerate(names, 1):
    t = subprocess.run(['pdftotext', '-layout', '%s/headwords-%s-thousand.pdf' % (sys.argv[2], n), '-'], capture_output=True, text=True).stdout
    ws = [w.lower() for w in re.findall(r'\b[A-Z][A-Z]+\b|\b[AI]\b', t.split('\n', 1)[1])]
    found = [rank[w] for w in ws if w in rank]
    print('Nation %2dk: %4d headwords, %3d%% in our list, median our rank %6d, %3d%% within our top %dk+-1k'
          % (k, len(ws), 100 * len(found) / max(1, len(ws)), statistics.median(found), 100 * sum(1 for r in found if (k - 2) * 1000 < r <= (k + 1) * 1000) / max(1, len(found)), k))
