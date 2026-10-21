#!/bin/sh
# Download the raw inputs into a scratch dir (NOT into the repo). Network needed; the server never runs this.
# usage: fetch_sources.sh /path/to/empty/raw-dir      (behind a corporate proxy the env -u ... below bypasses it)
set -e
RAW="${1:?raw dir}"; mkdir -p "$RAW"/wf "$RAW"/lem "$RAW"/hs "$RAW"/bad "$RAW"/prev "$RAW"/nat
get() { env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy curl -sSL -m 300 -A "Mozilla/5.0" -o "$1" "$2"; }
get "$RAW/wf/wordfreq-3.1.1-py3-none-any.whl" https://files.pythonhosted.org/packages/24/61/62835c475d69872d30689f284497853fe33fe1d6dd18f57346d13305861d/wordfreq-3.1.1-py3-none-any.whl
# only the data file is extracted from the wheel; no code from it is executed
mkdir -p "$RAW/wf-x" && unzip -oq "$RAW/wf/wordfreq-3.1.1-py3-none-any.whl" 'wordfreq/data/large_en.msgpack.gz' 'wordfreq-3.1.1.dist-info/*' -d "$RAW/wf-x"
get "$RAW/lem/lemmatization-en.txt" https://raw.githubusercontent.com/michmech/lemmatization-lists/master/lemmatization-en.txt
for f in index.dic index.aff license; do get "$RAW/hs/$f" https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en/$f; done
get "$RAW/bad/en" https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en
get "$RAW/prev/esm2.xlsx" "https://static-content.springer.com/esm/art%3A10.3758%2Fs13428-018-1077-9/MediaObjects/13428_2018_1077_MOESM2_ESM.xlsx"
for n in first second third fourth fifth sixth seventh eighth ninth tenth; do   # validation only, not redistributed
  get "$RAW/nat/headwords-$n-thousand.pdf" "https://www.wgtn.ac.nz/lals/resources/paul-nations-resources/vocabulary-lists/bnccoca-headword-lists/headwords-$n-thousand.pdf"
done
