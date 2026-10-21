#!/usr/bin/env python3
"""Build vocab-scale.json (reference points, unit = lemmas) + a per-band calibration from Brysbaert et al. (2019) prevalence norms.
usage: build_vocab_scale.py --freq en-freq.tsv --prevalence esm2.tsv --out vocab-scale.json
  esm2.tsv = first sheet of ESM 2 of Brysbaert, Mandera, McCormick & Keuleers (2019) (Word, Pknown, Nobs, Prevalence, FreqZipfUS),
  converted with read_xlsx.py. Reference points are hand-entered below from the cited sources."""
import argparse, json, statistics as st
ap = argparse.ArgumentParser()
for k in ('freq', 'prevalence', 'out'): ap.add_argument('--' + k, required=True)
a = ap.parse_args()

BRYS = 'https://doi.org/10.3389/fpsyg.2016.01116'
pts = [
 # ---- learners: X_Lex scores = lemmatised words out of the 5,000 most frequent (Meara & Milton 2003; Milton 2010 Table 5)
 dict(id='A1', label_ru='Начинающий A1', label_en='CEFR A1 learner', emoji='🌱', value=1000, range=[0, 1500], group='learner',
      source='Meara & Milton (2003) via Milton (2010), Table 5: X_Lex < 1500 lemmas; value = rough midpoint (range is open at the bottom)',
      url='https://www.eurosla.org/monographs/EM01/211-232Milton.pdf'),
 dict(id='A2', label_ru='Элементарный A2', label_en='CEFR A2 learner', emoji='🧳', value=2000, range=[1500, 2500], group='learner',
      source='Meara & Milton (2003) via Milton (2010), Table 5: X_Lex 1500-2500', url='https://www.eurosla.org/monographs/EM01/211-232Milton.pdf'),
 dict(id='B1', label_ru='Средний B1', label_en='CEFR B1 learner', emoji='🚲', value=3000, range=[2750, 3250], group='learner',
      source='Meara & Milton (2003) via Milton (2010), Table 5: X_Lex 2750-3250 (Milton & Alexiou 2020 quote 2500-3250)', url='https://www.eurosla.org/monographs/EM01/211-232Milton.pdf'),
 dict(id='B2', label_ru='Выше среднего B2', label_en='CEFR B2 learner', emoji='🚗', value=3500, range=[3250, 3750], group='learner',
      source='Meara & Milton (2003) via Milton (2010), Table 5: X_Lex 3250-3750', url='https://www.eurosla.org/monographs/EM01/211-232Milton.pdf'),
 dict(id='C1', label_ru='Продвинутый C1', label_en='CEFR C1 learner', emoji='✈️', value=4125, range=[3750, 4500], group='learner',
      source='Meara & Milton (2003) via Milton (2010), Table 5: X_Lex 3750-4500', url='https://www.eurosla.org/monographs/EM01/211-232Milton.pdf'),
 dict(id='C2', label_ru='Владение C2', label_en='CEFR C2 learner', emoji='🚀', value=4750, range=[4500, 5000], group='learner',
      source='Meara & Milton (2003) via Milton (2010), Table 5: X_Lex 4500-5000. X_Lex is capped at 5000, so this is a floor; Nation (see Vocabulary and the CEFR, Victoria Univ.) suggests 7000-9000 word families for C2',
      url='https://www.eurosla.org/monographs/EM01/211-232Milton.pdf'),
 # ---- natives. Children: sources count word families / root words; converted to lemmas (x ~1.35-1.4, see README) -> approximate
 dict(id='child5', label_ru='Ребёнок 5 лет', label_en='5-year-old child', emoji='👶', value=6000, range=[5400, 6750], group='native',
      source='Nation & Waring (1997): 4000-5000 word families at school entry, converted to lemmas x1.35 (approximate; original unit = word families)',
      url='https://www.lextutor.ca/research/nation_waring_97.html', approximate=True, original=dict(unit='word families', value=4500, range=[4000, 5000])),
 dict(id='child10', label_ru='Школьник 10 лет', label_en='10-year-old child', emoji='🎒', value=12500, range=[11800, 13300], group='native',
      source='Biemiller & Slonim (2001): ~8,400 root words by grade 5; Nation & Waring (1997) rule of 1000 families/year gives ~9,500; converted to lemmas x1.4 (approximate)',
      url='https://eric.ed.gov/?id=EJ640530', approximate=True, original=dict(unit='root words / word families', value=9000, range=[8400, 9500])),
 dict(id='teen16', label_ru='Подросток 16 лет', label_en='16-year-old', emoji='🎧', value=27000, range=[22000, 32000], group='native',
      source='Interpolation, not a measurement: Nation & Waring (1997) 1000 families/year (~15,500 families at 16) with the lemma/family ratio rising from 1.4 (10k families) to 2.1 (Brysbaert 20-year-old: 42,000 lemmas vs ~20,000 families); approximate',
      url='https://www.lextutor.ca/research/nation_waring_97.html', approximate=True, original=dict(unit='word families', value=15500)),
 dict(id='adult20', label_ru='Средний взрослый (20 лет)', label_en='Average 20-year-old native adult', emoji='🧑', value=42000, range=[27100, 51700], group='native',
      source='Brysbaert, Stevens, Mandera & Keuleers (2016), Frontiers in Psychology 7:1116, Table 4: median 42,000 lemmas, 5th-95th percentile 27,100-51,700 (list of 61,800 lemmas; 11,100 base words)',
      url=BRYS),
 dict(id='adult60', label_ru='Взрослый 60 лет', label_en='Average 60-year-old native adult', emoji='🧓', value=48200, range=[35100, 56400], group='native',
      source='Brysbaert et al. (2016), Table 4: median 48,200 lemmas, 5th-95th percentile 35,100-56,400', url=BRYS),
 dict(id='reader95', label_ru='Философ / начитанный (топ-5%)', label_en='"Philosopher": 95th percentile of 20-year-olds', emoji='🧐', value=51700, range=[51700, 56400], group='fun',
      source='Brysbaert et al. (2016), Table 4: 95th percentile 51,700 lemmas (20-year-olds); 56,400 = 95th percentile of 60-year-olds. "Philosopher" has no measured basis; label attached to the best-supported high benchmark',
      url=BRYS),
 dict(id='shakespeare', label_ru='Шекспир (то, что написал)', label_en="Shakespeare's published vocabulary", emoji='🎭', value=18500, range=[18500, 39000], group='fun',
      source='Efron & Thisted (1976), Biometrika 63(3):435-447: 31,534 distinct word forms in his works (types, incl. inflections, probably names); converted to lemmas /1.7 (Brysbaert et al. 2016, types = 1.7 x lemmas) = ~18,500; they estimate he knew >= 66,500 types (~39,000 lemmas). Measures words USED, not known',
      url='https://doi.org/10.1093/biomet/63.3.435', approximate=True, original=dict(unit='word types', value=31534, range=[31534, 66534])),
]

pk = {}
for l in open(a.prevalence, encoding='utf8').read().split('\n')[1:]:
    p = l.split('\t')
    if len(p) >= 3 and p[0]: pk[p[0]] = float(p[1])
words = [l.split('\t')[0] for l in open(a.freq, encoding='utf8').read().split('\n')[1:] if l]
band_prev, known = [], 0.0
for b in range(len(words) // 1000):
    ws = words[b * 1000:(b + 1) * 1000]
    m = st.mean(pk[w] for w in ws if w in pk)
    band_prev.append(round(m, 3)); known += m * len(ws)

out = {
 'unit': 'lemmas',
 'note': 'All values are counts of English lemmas (dictionary headwords, inflections merged; derived words such as "effortless"/"effortlessly" count separately). '
         'Word-family sources were converted (see per-point "original"); approximate=true marks converted/interpolated points. '
         'Learner values count lemmas among the 5,000 most frequent only (X_Lex cap).',
 'points': pts,
 'calibration': {
   'description': 'Mean Pknown (share of respondents who know the word; Brysbaert, Mandera, McCormick & Keuleers 2019, BRM 51:467-479, ESM 2) '
                  'for the lemmas of each 1000-rank band of en-freq.tsv (lemmas absent from their list, e.g. inflected forms kept as headwords, are skipped). '
                  'Use it to compare the test to the average adult: expected known lemmas within the list = sum(bandSize * bandPrevalence).',
   'bandPrevalence': band_prev,
   'expectedKnownInList_averageRespondent': round(known),
   'listSize': len(band_prev) * 1000,
   'caveat': 'Pknown is a population average over all respondents of that study (native/non-native mix and age spread not verified by me) and it is word-level, '
             'not person-level; treat as a rough yardstick.'
 }
}
json.dump(out, open(a.out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
open(a.out, 'a').write('\n')
print('expected known in list', round(known), band_prev, file=__import__('sys').stderr)
