#!/usr/bin/env python3
"""Check generated memo style and source overlap, not legal accuracy or plagiarism.
Usage: python3 scripts/quality_gates.py memo.txt source1.txt ...
"""
import argparse
import json
from pathlib import Path
import re
import sys

DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / 'src/reports/config.json'

def body_only(text):
    return re.split(r'^(?:INDEXED OFFICIAL SOURCES|SOURCE LEDGER)\s*$', text, maxsplit=1, flags=re.M | re.I)[0]

def mask_quotes(text):
    text = re.sub(r'“[^”]*”|"[^"]*"', ' ', text)
    return re.sub(r'\[(?:S\d+|C\d+(?:-\d+)?)(?:,\s*(?:S\d+|C\d+(?:-\d+)?))*\]', ' ', text)

def words(text):
    return re.findall(r"[a-z0-9']+", text.lower())

def shingles(tokens, n):
    return {tuple(tokens[i:i+n]) for i in range(len(tokens)-n+1)}

def check(memo, sources, config=None):
    config = config or json.loads(DEFAULT_CONFIG.read_text(encoding='utf-8'))
    body = body_only(memo)
    dash = re.findall(r'[\u2012-\u2015\u2212]|--+', body)
    banned = sorted({m.group(0).lower() for m in re.finditer(
        r'\b(?:' + '|'.join(re.escape(s) for s in config['bannedPhrases']) + r')\b', body, re.I)}) if config['bannedPhrases'] else []
    mine = shingles(words(mask_quotes(body)), config['shingleWords'])
    theirs = set().union(*(shingles(words(s), config['shingleWords']) for s in sources))
    overlap = len(mine & theirs) / len(mine) if mine else 0.0
    return {'dash_hits': len(dash), 'banned_phrases': banned, 'overlap_pct': round(100 * overlap, 1),
            'pass': not dash and not banned and overlap <= config['maxOverlap']}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('memo', type=Path)
    parser.add_argument('sources', nargs='*', type=Path)
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args()
    result = check(args.memo.read_text(encoding='utf-8'), [p.read_text(encoding='utf-8') for p in args.sources],
                   json.loads(args.config.read_text(encoding='utf-8')))
    print(json.dumps(result, indent=2))
    return 0 if result['pass'] else 1

if __name__ == '__main__':
    sys.exit(main())
