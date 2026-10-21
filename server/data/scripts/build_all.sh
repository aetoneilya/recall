#!/bin/sh
# Regenerate the three data files. usage: build_all.sh RAW_DIR   (RAW_DIR filled by fetch_sources.sh). Output goes to server/data/.
set -e
RAW="${1:?raw dir}"; HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="$HERE/.."
python3 -I "$HERE/build_en_freq.py" --wordfreq "$RAW/wf-x/wordfreq/data/large_en.msgpack.gz" --lemmas "$RAW/lem/lemmatization-en.txt" --hunspell "$RAW/hs/index.dic" --out "$OUT/en-freq.tsv"
python3 -I "$HERE/build_vocab_test.py" --freq "$OUT/en-freq.tsv" --wordfreq "$RAW/wf-x/wordfreq/data/large_en.msgpack.gz" --hunspell "$RAW/hs/index.dic" --lemmas "$RAW/lem/lemmatization-en.txt" --webster /usr/share/dict/words --bad "$RAW/bad/en" --out "$OUT/vocab-test.json"
python3 -I "$HERE/read_xlsx.py" "$RAW/prev/esm2.xlsx" "$RAW/prev/esm2.tsv"
python3 -I "$HERE/build_vocab_scale.py" --freq "$OUT/en-freq.tsv" --prevalence "$RAW/prev/esm2.tsv" --out "$OUT/vocab-scale.json"
# optional sanity checks against Nation's public headword PDFs (needs pdftotext)
# python3 -I "$HERE/validate_vs_nation.py" "$OUT/en-freq.tsv" "$RAW/nat"
