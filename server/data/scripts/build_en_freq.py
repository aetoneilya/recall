#!/usr/bin/env python3
"""Build en-freq.tsv: English lemma frequency ranks.

Inputs (all downloaded beforehand, see README):
  --wordfreq  large_en.msgpack.gz from the wordfreq 3.1.1 wheel (Speer 2022; CC BY-SA 4.0 data)
  --lemmas    lemmatization-en.txt (Mechura; ODbL) - 'lemma<TAB>inflected form' pairs
  --hunspell  en_US index.dic (SCOWL size 60 derived Hunspell dictionary) - used as a
              common-word filter: lowercase entries only (capitalised = proper nouns)
  --webster   optional /usr/share/dict/words (extra filter for abbreviations)
Output: TSV 'lemma<TAB>rank', rank 1 = most frequent.
"""
import argparse, gzip, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from msgpack_min import unpack

ap = argparse.ArgumentParser()
ap.add_argument('--wordfreq', required=True)
ap.add_argument('--lemmas', required=True)
ap.add_argument('--hunspell', required=True)
ap.add_argument('--webster', default=None)
ap.add_argument('--out', required=True)
ap.add_argument('--rows', type=int, default=30000)
a = ap.parse_args()

ALPHA = re.compile(r'^[a-z]+$')

# 1. token frequencies. wordfreq stores words in buckets: index i <-> frequency 10**(-i/100).
data = unpack(gzip.open(a.wordfreq).read())
assert data[0].get('format') == 'cB'
freq = {}
for i, words in enumerate(data[1:], start=1):
    f = 10 ** (-i / 100.0)
    for w in words:
        if ALPHA.match(w):
            freq[w] = freq.get(w, 0.0) + f

# 2. dictionary filter: lowercase hunspell base words (+ webster2 for abbreviation check)
dic = set()
with open(a.hunspell, encoding='utf8') as fh:
    next(fh)
    for line in fh:
        w = line.split('/')[0].strip()
        if ALPHA.match(w):
            dic.add(w)
web = set()
if a.webster:
    web = {l.strip() for l in open(a.webster, encoding='utf8', errors='ignore') if ALPHA.match(l.strip())}

# 3. inflected form -> candidate lemmas
cands = {}
with open(a.lemmas, encoding='utf-8-sig') as fh:
    for line in fh:
        p = line.rstrip('\r\n').split('\t')
        if len(p) != 2: continue
        lem, tok = p
        if ALPHA.match(lem) and ALPHA.match(tok) and lem != tok:
            cands.setdefault(tok, set()).add(lem)

# 4. lemmatise: a token maps to its most frequent candidate lemma, unless the token is itself
#    more frequent than that lemma AND is an -ing/-ed/-er/-est form listed as a headword in the
#    dictionary (e.g. 'building', 'interested', 'cooler': words in their own right). Irregular
#    and plural forms (was, feet, left, saw) always merge into their lemma.
m = {}
for tok, f in freq.items():
    target = tok
    if tok in cands:
        best = max(cands[tok], key=lambda l: freq.get(l, 0.0))
        own = tok in dic and tok.endswith(('ing', 'ed', 'er', 'est')) and f > freq.get(best, 0.0)
        if not own:
            target = best
    m[tok] = target

def resolve(t):
    for _ in range(5):  # follow chains such as runnings -> running -> run
        nt = m.get(t, t)
        if nt == t: break
        t = nt
    return t

lemf = {}
for tok, f in freq.items():
    t = resolve(tok)
    lemf[t] = lemf.get(t, 0.0) + f

# 5. keep dictionary words only (webster2 is used by the test-bank builder, not here) (drops proper nouns, slang, typos, foreign words)
rows = [(l, f) for l, f in lemf.items() if l in dic]
# deterministic tie-break: frequency desc, then lemma
rows.sort(key=lambda x: (-round(x[1], 12), x[0]))
rows = rows[:a.rows]
with open(a.out, 'w', encoding='utf8', newline='\n') as fh:
    fh.write('lemma\trank\n')
    for r, (l, f) in enumerate(rows, 1):
        fh.write('%s\t%d\n' % (l, r))
print('rows', len(rows), 'of', len([1 for l in lemf if l in dic]), 'dictionary lemmas', file=sys.stderr)
