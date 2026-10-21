#!/usr/bin/env python3
"""Rough families->lemmas conversion at low levels: for Nation's first N BNC/COCA headwords, the rank in OUR lemma list
that covers 50% of them (median) and 90%; ratio = rank/N. usage: family_to_lemma_ratio.py en-freq.tsv nat_dir"""
import sys, re, subprocess
rank = {}
for l in open(sys.argv[1], encoding='utf8').read().split('\n')[1:]:
    if l: w, r = l.split('\t'); rank[w] = int(r)
names = 'first second third fourth fifth sixth seventh eighth ninth tenth'.split()
heads = []
for n in names:
    t = subprocess.run(['pdftotext', '-layout', '%s/headwords-%s-thousand.pdf' % (sys.argv[2], n), '-'], capture_output=True, text=True).stdout
    heads.append([w.lower() for w in re.findall(r'\b[A-Z][A-Z]+\b|\b[AI]\b', t.split('\n', 1)[1])])
for k in (1, 2, 3, 4, 5, 6, 8, 10):
    ws = [w for h in heads[:k] for w in h]
    rs = sorted(rank[w] for w in ws if w in rank)
    n = len(ws)
    print('N=%5d families: our rank covering 50%% = %6d (x%.2f), 90%% = %6d (x%.2f); %d%% of headwords found' % (n, rs[len(rs)//2], rs[len(rs)//2]/n, rs[int(len(rs)*.9)], rs[int(len(rs)*.9)]/n, 100*len(rs)/n))
