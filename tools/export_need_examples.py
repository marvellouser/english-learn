#!/usr/bin/env python3
"""Export words that still lack examples into chunk files for AI enrichment.

Each chunk is a JSON array of {word, def_zh, def_en, phonetic} (the context an
agent needs to write a sense-accurate example). Chunks land in
tools/enrichment/chunks/need-NNN.json. Deterministic order (dataset order) so
re-runs are stable.

Usage: python3 tools/export_need_examples.py [CHUNK_SIZE]
"""
import json, os, sys

DATA = "data/seed-words.json"
OUT_DIR = "tools/enrichment/chunks"
chunk_size = int(sys.argv[1]) if len(sys.argv) > 1 else 200

data = json.load(open(DATA, encoding="utf-8"))
need = [w for w in data if not (w.get("examples") or [])]

os.makedirs(OUT_DIR, exist_ok=True)
# clear stale chunks
for f in os.listdir(OUT_DIR):
    if f.startswith("need-") and f.endswith(".json"):
        os.remove(os.path.join(OUT_DIR, f))

n = 0
for i in range(0, len(need), chunk_size):
    n += 1
    rows = [{
        "word": w["word"],
        "def_zh": w.get("def_zh", ""),
        "def_en": w.get("def_en", ""),
        "phonetic": w.get("phonetic", ""),
    } for w in need[i:i + chunk_size]]
    path = os.path.join(OUT_DIR, f"need-{n:03d}.json")
    json.dump(rows, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

print(f"need-examples words : {len(need)}")
print(f"chunk size          : {chunk_size}")
print(f"chunks written      : {n}  -> {OUT_DIR}/need-NNN.json")
