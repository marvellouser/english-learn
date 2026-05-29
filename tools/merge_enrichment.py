#!/usr/bin/env python3
"""Merge an AI-enrichment batch into the seed-words dataset.

Reusable across batches (batch-001, batch-002, ...). The batch file is an
object keyed by word:

    {
      "<word>": {
        "examples": ["..."],      # required: fills examples if currently empty
        "root_affix": "...",       # optional: fills root_affix only if currently empty
        "def_zh": "..."            # optional: overrides def_zh when provided
      },
      ...
    }

Merge rules (non-destructive by default):
  - examples : fill only when the dataset entry's examples list is empty.
  - root_affix: fill only when the dataset entry's root_affix is empty ("").
  - def_zh   : override only when the batch entry explicitly provides a non-empty def_zh.
  - everything else (id, word, phonetic, def_en, tags, freq) is preserved.

Word matching is case-insensitive on the dataset 'word' field. All ids and the
total word count are preserved; the script validates this before writing back.

Usage:
    python3 tools/merge_enrichment.py [DATA_FILE] [BATCH_FILE]

Defaults:
    DATA_FILE  = data/seed-words.json
    BATCH_FILE = tools/enrichment/batch-001.json
"""
import json
import sys
import os

DEFAULT_DATA = "data/seed-words.json"
DEFAULT_BATCH = "tools/enrichment/batch-001.json"


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    data_file = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DATA
    batch_file = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_BATCH

    if not os.path.exists(data_file):
        print("ERROR: data file not found: %s" % data_file)
        return 1
    if not os.path.exists(batch_file):
        print("ERROR: batch file not found: %s" % batch_file)
        return 1

    data = load_json(data_file)
    batch = load_json(batch_file)

    if not isinstance(data, list):
        print("ERROR: data file must be a JSON array of word objects")
        return 1
    if not isinstance(batch, dict):
        print("ERROR: batch file must be a JSON object keyed by word")
        return 1

    before_count = len(data)
    before_ids = [w.get("id") for w in data]
    before_with_examples = sum(1 for w in data if w.get("examples"))

    # Index dataset by lowercase word (first occurrence wins).
    index = {}
    for i, w in enumerate(data):
        key = str(w.get("word", "")).strip().lower()
        if key and key not in index:
            index[key] = i

    filled_examples = 0
    filled_root = 0
    overrode_def = 0
    unmatched = []

    for word, payload in batch.items():
        key = str(word).strip().lower()
        if key not in index:
            unmatched.append(word)
            continue
        entry = data[index[key]]

        new_examples = payload.get("examples")
        if new_examples:
            if not entry.get("examples"):
                entry["examples"] = list(new_examples)
                filled_examples += 1
            # if already has curated examples, leave them untouched

        new_root = payload.get("root_affix")
        if new_root:  # non-empty string
            if not entry.get("root_affix"):
                entry["root_affix"] = new_root
                filled_root += 1

        new_def = payload.get("def_zh")
        if new_def:  # explicit non-empty override
            if entry.get("def_zh") != new_def:
                entry["def_zh"] = new_def
                overrode_def += 1

    # Validation: count and ids must be preserved.
    after_count = len(data)
    after_ids = [w.get("id") for w in data]
    if after_count != before_count:
        print("ERROR: word count changed (%d -> %d); aborting." % (before_count, after_count))
        return 1
    if after_ids != before_ids:
        print("ERROR: id list changed; aborting write.")
        return 1

    # Every entry must still have the required fields.
    required = ("id", "word", "phonetic", "def_zh", "def_en", "examples", "root_affix", "tags", "freq")
    for w in data:
        for field in required:
            if field not in w:
                print("ERROR: entry %s missing field '%s'; aborting." % (w.get("id"), field))
                return 1

    with open(data_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    after_with_examples = sum(1 for w in data if w.get("examples"))

    print("Merged batch: %s" % batch_file)
    print("  batch entries           : %d" % len(batch))
    print("  examples filled         : %d" % filled_examples)
    print("  root_affix filled       : %d" % filled_root)
    print("  def_zh overridden       : %d" % overrode_def)
    print("  unmatched batch words   : %d %s" % (len(unmatched), unmatched if unmatched else ""))
    print("  with-examples before    : %d" % before_with_examples)
    print("  with-examples after     : %d" % after_with_examples)
    print("  total words (unchanged) : %d" % after_count)
    return 0


if __name__ == "__main__":
    sys.exit(main())
