#!/usr/bin/env python3
"""Merge example-translation batches (tools/enrichment/tr-batch-*.json) into
data/seed-words.json. Each batch is keyed by word -> {"zh": [中文,...]} parallel
to that word's examples[].en order. Non-destructive: only fills examples[i].zh.
Usage: python3 tools/merge_translations.py [DATA] [BATCH1 BATCH2 ...]"""
import json, sys, glob

data_path = sys.argv[1] if len(sys.argv) > 1 else "data/seed-words.json"
batch_paths = sys.argv[2:] or sorted(glob.glob("tools/enrichment/tr-batch-*.json"))

data = json.load(open(data_path, encoding="utf-8"))
by_word = {w["word"]: w for w in data}
filled = 0
for bp in batch_paths:
    batch = json.load(open(bp, encoding="utf-8"))
    for word, payload in batch.items():
        rec = by_word.get(word)
        if not rec:
            continue
        zhs = payload.get("zh", [])
        for i, ex in enumerate(rec.get("examples", [])):
            if i < len(zhs) and isinstance(ex, dict) and zhs[i] and not ex.get("zh"):
                ex["zh"] = zhs[i]; filled += 1
json.dump(data, open(data_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
total = len(data)
with_zh = sum(1 for w in data for e in (w.get("examples") or []) if isinstance(e, dict) and e.get("zh"))
print(f"filled zh translations: {filled}")
print(f"examples with zh now  : {with_zh}")
print(f"total words           : {total}")
