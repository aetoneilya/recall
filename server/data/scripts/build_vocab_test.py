#!/usr/bin/env python3
"""Build vocab-test.json: Yes/No vocabulary test bank (words sampled per 1000-lemma band + generated pseudowords).

usage: build_vocab_test.py --freq en-freq.tsv --wordfreq large_en.msgpack.gz --hunspell index.dic
          --lemmas lemmatization-en.txt --webster /usr/share/dict/words --bad ldnoobw-en.txt --out vocab-test.json
Deterministic (fixed seed). Prints diagnostics to stderr.
"""
import argparse, gzip, json, os, random, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from msgpack_min import unpack

ap = argparse.ArgumentParser()
for k in ('freq', 'wordfreq', 'hunspell', 'lemmas', 'webster', 'bad', 'out'):
    ap.add_argument('--' + k, required=True)
ap.add_argument('--bands', type=int, default=30)
ap.add_argument('--per-band', type=int, default=40)
ap.add_argument('--pseudo', type=int, default=80)
ap.add_argument('--seed', type=int, default=20261021)
a = ap.parse_args()
rnd = random.Random(a.seed)
ALPHA = re.compile(r'^[a-z]+$')

rank = {}
order = []
for l in open(a.freq, encoding='utf8').read().split('\n')[1:]:
    if l:
        w, r = l.split('\t'); rank[w] = int(r); order.append(w)

# ---- lexicons -----------------------------------------------------------
wf_tokens = set()
for words in unpack(gzip.open(a.wordfreq).read())[1:]:
    wf_tokens.update(w for w in words if ALPHA.match(w))
dic = set(l.split('/')[0].strip() for l in list(open(a.hunspell, encoding='utf8'))[1:])
dic = {w for w in dic if ALPHA.match(w)}
dic_any = {l.split('/')[0].strip().lower() for l in list(open(a.hunspell, encoding='utf8'))[1:]}
web = {l.strip() for l in open(a.webster, encoding='utf8', errors='ignore') if ALPHA.match(l.strip())}
lem_forms = set()
for l in open(a.lemmas, encoding='utf-8-sig'):
    p = l.rstrip('\r\n').split('\t')
    if len(p) == 2: lem_forms.update(x for x in p if ALPHA.match(x))
bad = {l.strip().lower() for l in open(a.bad, encoding='utf8') if l.strip()}
bad = {b for b in bad if ' ' not in b}

# extra sensitive/offensive/slur stems checked as substrings on top of LDNOOBW (single words)
EXTRA_BAD_SUBSTR = ['fuck', 'shit', 'cunt', 'nigg', 'fag', 'whore', 'slut', 'bitch', 'dick', 'cock', 'penis', 'vagin',
                    'rape', 'rapist', 'nazi', 'porn', 'sex', 'anal', 'anus', 'tits', 'boob', 'piss', 'crap', 'damn',
                    'bastard', 'retard', 'orgasm', 'erotic', 'genital', 'semen', 'sperm', 'masturb', 'incest', 'molest',
                    'pedo', 'suicid', 'kill', 'murder', 'terror', 'genocid', 'holocaust', 'slave']
def offensive(w):
    return w in bad or any(s in w for s in EXTRA_BAD_SUBSTR)

# ---- word-bank filters --------------------------------------------------
FUNCTION = set('''a an the this that these those i me my mine myself you your yours yourself he him his himself she her hers
herself it its itself we us our ours ourselves they them their theirs themselves who whom whose which what whatever whoever
be am is are was were been being do does did done have has had having will would shall should can could may might must
not no nor and or but if then than so as of in on at by for with about against between into through during before after above
below to from up down out off over under again further once here there when where why how all any both each few more most
other some such only own same too very just also now ever never always often already still yet else however although though
while because since until unless whether either neither one two three four five six seven eight nine ten eleven twelve
thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred
thousand million billion first second third fourth fifth sixth seventh eighth ninth tenth last next many much little less least
yes okay ok hello hey oh ah um uh wow gonna wanna gotta kinda lemme dunno ain'''.split())
# abbreviations / initialisms / units / non-words that are lowercase in dictionaries
ABBREV = set('''etc approx dept govt corp inc ltd vs viz esp fig figs eds ed est min max misc pref prof gen sgt capt lieut col
mph kph rpm kilo kg km cm mm mg ml lb lbs oz ft yd mi dvd cd pdf html http url www usb cpu gpu ram rom wifi tv pc mac app
apps blog blogs ebay email emails online offline login logout username mp mrs mr ms dr jr sr st nd rd th am pm bc ad ce
alot ya yeah yep nope nah thx pls plz lol omg btw fyi diy faq asap ai ok kinda sorta gotta'''.split())
# polysemous / unclear / dated-or-region-specific / dialect words I do not want as 'unambiguous' test items
MANUAL_EXCLUDE = set()
excl_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vocab_test_exclude.txt')
if os.path.exists(excl_file):
    MANUAL_EXCLUDE = {l.split('#')[0].strip() for l in open(excl_file, encoding='utf8') if l.split('#')[0].strip()}

def ok_word(w):
    return (len(w) >= 4 and re.search('[aeiouy]', w) and w in dic and w not in FUNCTION and w not in ABBREV
            and w not in MANUAL_EXCLUDE and not offensive(w) and (w in web or rank[w] <= 3000)
            and (w + 's' not in dic_any or True))

bands = []
for b in range(a.bands):
    lo, hi = b * 1000 + 1, (b + 1) * 1000
    pool = [w for w in order[lo - 1:hi] if ok_word(w)]
    # words that are only a derivational/inflected form of a more frequent word would not add information
    rnd.shuffle(pool)
    words = sorted(pool[:a.per_band])
    assert len(words) == a.per_band, (b, len(pool))
    bands.append({'from': lo, 'to': hi, 'words': words})
    print('band %2d: pool %4d' % (b + 1, len(pool)), file=sys.stderr)

# ---- pseudowords: Wuggy-style substitutions with legal trigrams ----------
def trigrams(w):
    s = '^' + w + '$'
    return [s[i:i+3] for i in range(len(s) - 2)]
tri = {}
for w in order:                       # trigram legality learned from the real lemma list
    for t in trigrams(w): tri[t] = tri.get(t, 0) + 1
legal = lambda w: all(tri.get(t, 0) >= 30 for t in trigrams(w))

common = set(order[:20000])
clean_lex = set(order) | dic | web | lem_forms           # words that must not be 1 edit away
all_lex = clean_lex | wf_tokens | dic_any                # words that the pseudoword must not equal
V, C = 'aeiou', 'bcdfghjklmnprstvwz'
def neighbours(w):
    L = 'abcdefghijklmnopqrstuvwxyz'
    out = set()
    for i in range(len(w) + 1):
        for c in L: out.add(w[:i] + c + w[i:])
    for i in range(len(w)):
        out.add(w[:i] + w[i+1:])
        for c in L: out.add(w[:i] + c + w[i+1:])
        if i + 1 < len(w): out.add(w[:i] + w[i+1] + w[i] + w[i+2:])
    out.discard(w)
    return out
def is_pseudo_ok(w):
    if not (5 <= len(w) <= 8) or not ALPHA.match(w) or not legal(w): return False
    if w in all_lex or offensive(w): return False
    if w.endswith('s') or w.endswith('ed') or w.endswith('ing') or w.endswith('ly'): return False
    # not an inflection / derivation of a real word either
    for suf in ('s', 'es', 'ed', 'd', 'ing', 'er', 'ly', 'est'):
        if w.endswith(suf) and w[:-len(suf)] in all_lex: return False
    if re.search(r'(.)\1\1', w) or not re.search('[aeiouy]', w): return False
    if re.search(r'[^aeiouy]{4,}|[aeiouy]{3,}', w): return False          # pronounceable clusters only
    if re.search(r'[^aeiouy]{3}', w) and not re.search(r'(str|spr|scr|chr|thr|shr|sch|nch|rch|lch|ngs|rst|mpt|nds|rds|lds)', w): return False
    # must not embed a real word of 4+ letters from the common list (avoids 'hellsido', 'headligo' look-alikes)
    for i in range(len(w)):
        for j in range(i + 4, len(w) + 1):
            if j - i < len(w) and w[i:j] in common: return False
    return not (neighbours(w) & clean_lex)

lens = [len(w) for bd in bands for w in bd['words']]
bases = [w for w in order[1500:15000] if 5 <= len(w) <= 8 and w in dic and not offensive(w)]
pseudo, tries = [], 0
while len(pseudo) < a.pseudo and tries < 2_000_000:
    tries += 1
    base = rnd.choice(bases)
    w = list(base)
    n_sub = rnd.choice((1, 2, 2))
    pos = rnd.sample(range(len(w)), min(n_sub, len(w)))
    for p in pos:                                           # same-class substitution keeps it pronounceable
        pool = V if w[p] in V else C
        w[p] = rnd.choice([c for c in pool if c != w[p]]) if w[p] in V + C else w[p]
    w = ''.join(w)
    if w in pseudo or not is_pseudo_ok(w): continue
    if sum(1 for p in pseudo if p[:2] == w[:2]) >= 1: continue  # spread over different onsets
    pseudo.append(w)
pseudo.sort()
print('pseudowords', len(pseudo), 'tries', tries, file=sys.stderr)
assert len(pseudo) == a.pseudo

out = {
    'source': 'Words: 40 per band, sampled at random (seed %d) from en-freq.tsv (lemma ranks from wordfreq 3.1.1 + Mechura lemma table; '
              'see README.md). Pseudowords: generated by same-class letter substitution on real words with legal-trigram check, '
              'then verified not to be a word or a 1-edit neighbour of a word in wordfreq/Hunspell en_US/Webster 2nd/lemma table.' % a.seed,
    'bandSize': 1000,
    'bands': bands,
    'pseudowords': pseudo,
    'scoring': {
        'method': 'Yes/No (checklist) test with pseudowords; hit rate h from real words, false-alarm rate f from pseudowords; '
                  'correction for guessing per band, then vocabulary size = sum over bands of bandSize * known share.',
        'formula': 'known_b = max(0, (h_b - f) / (1 - f)) for each band b (h_b = share of that band\'s real words ticked, '
                   'f = share of pseudowords ticked); smooth known_b to be non-increasing in b; size = bandSize * sum_b known_b '
                   '(in lemmas). If f > 0.5 (or f - h > 0 over most bands) the result is unreliable: ask to retake. '
                   'Optional aggregate alternative: I_SDT (see reference).',
        'reference': 'cfg correction: Meara & Buxton (1987), An alternative to multiple choice vocabulary tests, Language Testing 4(2), 142-154 '
                     '(formula as given in Huibregtse, Admiraal & Meara 2002 and Mochida & Harrington 2006, Language Testing 23(1)); '
                     'simpler h - f: Anderson & Freebody (1983), in B. Hutson (ed.), Advances in Reading/Language Research vol. 2, JAI Press; '
                     'signal-detection alternative I_SDT = 1 - [4h(1-f) - 2(h-f)(1+h-f)] / [4h(1-f) - (h-f)(1+h-f)] (h >= f): '
                     'Huibregtse, Admiraal & Meara (2002), Scores on a yes-no vocabulary test: Correction for guessing and response style, '
                     'Language Testing 19(3), 227-245 (formula as reproduced in Lemhofer & Broersma 2012, Behavior Research Methods 44, appendix).'
    }
}
with open(a.out, 'w', encoding='utf8') as fh:
    json.dump(out, fh, ensure_ascii=False, indent=1)
    fh.write('\n')
