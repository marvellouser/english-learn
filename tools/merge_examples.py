#!/usr/bin/env python3
"""Merge AI example batches into data/seed-words.json.

Batch format (object keyed by word):
    { "<word>": { "examples": [ {"en": "...", "zh": "..."}, ... ] }, ... }

Also accepts examples as plain strings or {en} only; zh defaults to "".

Non-destructive: fills examples ONLY for dataset entries whose examples list is
currently empty. Matches by lowercase word. Validates word count + id list are
unchanged before writing. Optionally fills def_en when a batch entry provides
"def_en" and the dataset entry's def_en is empty.

Usage: python3 tools/merge_examples.py [DATA] [BATCH ...]
Default DATA=data/seed-words.json, default batches=tools/enrichment/ex-batch-*.json
"""
import json, sys, glob, os

data_path = sys.argv[1] if len(sys.argv) > 1 else "data/seed-words.json"
batch_paths = sys.argv[2:] or sorted(glob.glob("tools/enrichment/ex-batch-*.json"))

data = json.load(open(data_path, encoding="utf-8"))
before_count = len(data)
before_ids = [w.get("id") for w in data]

index = {}
for i, w in enumerate(data):
    k = str(w.get("word", "")).strip().lower()
    if k and k not in index:
        index[k] = i

def norm_ex(e):
    if isinstance(e, dict):
        en = str(e.get("en", "") or "").strip()
        zh = str(e.get("zh", "") or "").strip()
    else:
        en, zh = str(e or "").strip(), ""
    return {"en": en, "zh": zh} if en else None

filled, filled_def_en, unmatched = 0, 0, []
for bp in batch_paths:
    batch = json.load(open(bp, encoding="utf-8"))
    for word, payload in batch.items():
        k = str(word).strip().lower()
        if k not in index:
            unmatched.append(word); continue
        entry = data[index[k]]
        exs = [x for x in (norm_ex(e) for e in (payload.get("examples") or [])) if x]
        if exs and not (entry.get("examples") or []):
            entry["examples"] = exs; filled += 1
        de = str(payload.get("def_en", "") or "").strip()
        if de and not str(entry.get("def_en", "") or "").strip():
            entry["def_en"] = de; filled_def_en += 1

assert len(data) == before_count, "word count changed!"
assert [w.get("id") for w in data] == before_ids, "id list changed!"

json.dump(data, open(data_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)

still_empty = sum(1 for w in data if not (w.get("examples") or []))
print(f"batches merged        : {len(batch_paths)}")
print(f"examples filled       : {filled}")
print(f"def_en filled         : {filled_def_en}")
print(f"unmatched batch words : {len(unmatched)} {unmatched[:10]}")
print(f"words still w/o examples: {still_empty}")
print(f"total words           : {len(data)}")
