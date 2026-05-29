#!/usr/bin/env python3
# build_vocab.py
# Reproducible data pipeline that expands the offline vocab PWA from the curated
# 441-word seed to ~7500 words using the ECDICT open dictionary, and stamps a
# REAL COCA frequency rank (`freq`) onto every word so the app can order study
# by frequency and estimate vocabulary size by frequency band.
#
# USAGE
#   python3 tools/build_vocab.py [--ecdict PATH] [--seed PATH] [--out PATH]
#                                [--affixes PATH] [--target N]
#
# DEFAULTS (run from the project root):
#   --ecdict   the ECDICT CSV at the path recorded below (770k rows)
#   --seed     tools/seed-words.original.json (the pristine curated 441-word seed)
#   --out      data/seed-words.json   (the regenerated full dataset)
#   --affixes  tools/affixes.json     (curated morpheme knowledge base)
#   --target   7500                   (top-N COCA-ranked lemmas to import)
#
# IDEMPOTENCE / SOURCE OF TRUTH
#   The 441 curated words live in tools/seed-words.original.json (id, phonetic,
#   def_zh, def_en, examples, root_affix and curated tags). The build READS that
#   pristine seed and WRITES the expanded dataset to data/seed-words.json, so the
#   pipeline is fully reproducible and re-runnable: re-running always reproduces
#   the same output and never mutates the curated source.
#
# GUARANTEES
#   - Every existing seed word's id, examples and root_affix are PRESERVED
#     (reviewState is keyed by id, so existing ids must stay stable).
#   - New ids continue the wNNNN numbering after the current max.
#   - Output is a valid JSON array; stats are printed to stdout.
#
# The script is dependency-free (Python 3 standard library only).

import argparse
import csv
import json
import os
import re
import sys

# ---------------------------------------------------------------------------
# Paths / constants
# ---------------------------------------------------------------------------

# Project root = parent of this tools/ directory.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

DEFAULT_ECDICT = (
    "/Users/sam/.claude/projects/-Users-sam-project-english-learn/"
    ".workflow/.data-pipeline/ecdict.csv"
)
DEFAULT_SEED = os.path.join(SCRIPT_DIR, "seed-words.original.json")
DEFAULT_OUT = os.path.join(PROJECT_ROOT, "data", "seed-words.json")
DEFAULT_AFFIXES = os.path.join(SCRIPT_DIR, "affixes.json")
DEFAULT_TARGET = 7500

# Word surface filter: lowercase single token; allow internal hyphen/apostrophe;
# 2..20 chars total (first char a..z).
WORD_RE = re.compile(r"^[a-z][a-z'\-]{1,19}$")

# Exam tags recognised in the ECDICT `tag` column (space-separated).
EXAM_TAGS = {"zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"}

# Frequency bands -> band tag. (1-based COCA rank.)
FREQ_BANDS = [
    (1, 1000, "top1000"),
    (1001, 2000, "top2000"),
    (2001, 3000, "top3000"),
    (3001, 5000, "top5000"),
    (5001, 8000, "top8000"),
]

# ---------------------------------------------------------------------------
# Curated programming / CS terms. Looked up in ECDICT for phonetic/def_zh/def_en;
# when absent (many modern CS terms are not in ECDICT) a short curated def_zh is
# used so the word is still study-able. ~100 terms.
# ---------------------------------------------------------------------------

PROGRAMMING_TERMS = {
    "compiler": "编译器", "interpreter": "解释器", "runtime": "运行时", "compile": "编译",
    "syntax": "语法", "semantics": "语义", "variable": "变量", "constant": "常量",
    "function": "函数", "method": "方法", "parameter": "参数", "argument": "实参",
    "boolean": "布尔值", "integer": "整数", "string": "字符串", "array": "数组",
    "object": "对象", "class": "类", "instance": "实例", "interface": "接口",
    "inheritance": "继承", "polymorphism": "多态", "encapsulation": "封装", "abstraction": "抽象",
    "recursion": "递归", "recursive": "递归的", "iterator": "迭代器", "iteration": "迭代",
    "loop": "循环", "closure": "闭包", "callback": "回调", "lambda": "匿名函数",
    "async": "异步的", "asynchronous": "异步的", "synchronous": "同步的", "concurrency": "并发",
    "parallelism": "并行", "thread": "线程", "process": "进程", "mutex": "互斥锁",
    "semaphore": "信号量", "deadlock": "死锁", "throughput": "吞吐量", "latency": "延迟",
    "kernel": "内核", "pointer": "指针", "reference": "引用", "heap": "堆",
    "stack": "栈", "queue": "队列", "deque": "双端队列", "tree": "树",
    "graph": "图", "node": "节点", "edge": "边", "vertex": "顶点",
    "hash": "哈希", "hashtable": "哈希表", "map": "映射", "set": "集合",
    "list": "列表", "tuple": "元组", "schema": "模式;架构", "query": "查询",
    "index": "索引", "primary": "主键的", "foreign": "外键的", "transaction": "事务",
    "rollback": "回滚", "commit": "提交", "branch": "分支", "merge": "合并",
    "rebase": "变基", "repository": "代码仓库", "clone": "克隆", "fork": "派生",
    "deploy": "部署", "deployment": "部署", "pipeline": "流水线", "container": "容器",
    "namespace": "命名空间", "module": "模块", "package": "包", "dependency": "依赖",
    "framework": "框架", "library": "库", "middleware": "中间件", "endpoint": "端点",
    "router": "路由器", "routing": "路由", "request": "请求", "response": "响应",
    "payload": "负载;数据体", "header": "报头", "cookie": "会话标记", "session": "会话",
    "token": "令牌", "authentication": "认证", "authorization": "授权", "encryption": "加密",
    "decryption": "解密", "cache": "缓存", "buffer": "缓冲区", "serialize": "序列化",
    "serialization": "序列化", "deserialize": "反序列化", "regex": "正则表达式", "regexp": "正则表达式",
    "refactor": "重构", "debug": "调试", "exception": "异常", "throw": "抛出(异常)",
    "catch": "捕获(异常)", "idempotent": "幂等的", "immutable": "不可变的", "mutable": "可变的",
    "scalability": "可扩展性", "bandwidth": "带宽", "protocol": "协议", "socket": "套接字",
    "binary": "二进制", "bitwise": "按位的", "overflow": "溢出", "underflow": "下溢",
    "scope": "作用域", "operator": "运算符", "expression": "表达式", "statement": "语句",
    "literal": "字面量", "enum": "枚举", "struct": "结构体", "generic": "泛型",
    "polyfill": "兼容补丁", "virtualization": "虚拟化", "concurrent": "并发的",
}


# ---------------------------------------------------------------------------
# Text cleaning helpers
# ---------------------------------------------------------------------------

# The ECDICT CSV stores multi-sense separators as the LITERAL two characters
# backslash + n (not a real newline), so we split on the literal "\n".
LITERAL_NL = "\\n"

# Noise markers like [网络] / [计] / [经] that prefix a sense.
NOISE_PREFIX_RE = re.compile(r"^\s*\[[^\]]{1,8}\]\s*")


def clean_def_zh(translation):
    """Clean an ECDICT `translation` into a short Chinese definition.

    - split on the literal "\\n" sense separator
    - drop "[网络]"-style noise senses and strip "[计]/[经]" sense prefixes
    - take the first 1-2 useful senses, join with the Chinese semicolon
    """
    if not translation:
        return ""
    raw_senses = [s.strip() for s in translation.split(LITERAL_NL)]
    senses = []
    for s in raw_senses:
        if not s:
            continue
        # Skip pure-noise network senses entirely.
        if s.startswith("[网络]"):
            continue
        # Strip a leading short bracket tag like [计]/[经]/[医].
        s = NOISE_PREFIX_RE.sub("", s).strip()
        # Collapse internal whitespace.
        s = re.sub(r"\s+", " ", s)
        if s:
            senses.append(s)
        if len(senses) >= 2:
            break
    if not senses:
        # Fall back to the first non-empty raw sense (even if it was network).
        for s in raw_senses:
            s = re.sub(r"\s+", " ", s).strip()
            if s:
                return s
        return ""
    return "；".join(senses)


def clean_def_en(definition):
    """First sentence/line of the English `definition` (concise)."""
    if not definition:
        return ""
    first = definition.split(LITERAL_NL)[0].strip()
    first = re.sub(r"\s+", " ", first)
    return first


def wrap_phonetic(phonetic):
    """Wrap a bare ECDICT IPA in slashes; empty string when absent."""
    p = (phonetic or "").strip()
    if not p:
        return ""
    return "/%s/" % p


def is_inflected_form(exchange):
    """True when the ECDICT `exchange` marks the word as a form of another lemma.

    ECDICT encodes morphology as key:value pairs separated by '/'. The key '0'
    holds the lemma when the word is an INFLECTED FORM (e.g. running -> 0:run).
    We want lemmas only, so any row carrying a '0:' tag is skipped.
    """
    if not exchange:
        return False
    for part in exchange.split("/"):
        if part.startswith("0:") and len(part) > 2:
            return True
    return False


def freq_band_tag(freq):
    """Map a positive COCA rank to its frequency-band tag, else None."""
    if not freq or freq <= 0:
        return None
    for lo, hi, tag in FREQ_BANDS:
        if lo <= freq <= hi:
            return tag
    return "top8000"  # ranked but beyond the top bands -> coarse last band


# ---------------------------------------------------------------------------
# Rule-based root/affix annotation
# ---------------------------------------------------------------------------


class AffixAnnotator:
    """Compose a short Chinese root_affix note from a curated morpheme KB.

    Only CONFIDENT matches are emitted: a recognised prefix at the start, a
    recognised suffix at the end, and/or a recognised root somewhere in the
    remaining stem. When nothing confident matches, returns "" (no fabrication).
    """

    def __init__(self, kb):
        # Build longest-first match lists so 'inter' beats 'in', 'tion' beats 'al'.
        self.prefixes = self._index(kb.get("prefixes", []))
        self.suffixes = self._index(kb.get("suffixes", []))
        self.roots = self._index(kb.get("roots", []))

    @staticmethod
    def _index(entries):
        items = []
        for e in entries:
            zh = e.get("zh", "")
            for surface in e.get("match", []):
                if surface:
                    items.append((surface, zh))
        # Longest surface first for greedy, specific matching.
        items.sort(key=lambda t: len(t[0]), reverse=True)
        return items

    def annotate(self, word):
        # Only handle plain alphabetic words (skip hyphen/apostrophe forms).
        if not word or not word.isalpha():
            return ""
        w = word.lower()
        if len(w) < 4:
            return ""

        prefix_note = None
        root_note = None
        suffix_note = None
        matched_prefix = False
        matched_root = False
        stem = w

        # Prefix (require a reasonable remaining stem so we don't shave real words).
        # Only multi-letter (>=3) prefixes are trusted on their own surface; short
        # 2-letter assimilation forms (co-, de-, un-, ab-, ad- aliases ...) match
        # too many coincidental letter sequences, so a lone short prefix is NOT a
        # confident morpheme and is only kept when it pairs with a real root.
        for surface, zh in self.prefixes:
            if (
                stem.startswith(surface)
                and len(stem) - len(surface) >= 3
                and surface != stem
            ):
                prefix_note = "前缀 %s-(%s)" % (surface, zh)
                matched_prefix = len(surface) >= 3
                stem = stem[len(surface):]
                short_prefix = len(surface) < 3
                break
        else:
            short_prefix = False

        # Suffix (peel the end; keep a usable stem). A suffix is supporting detail
        # only; it never makes an annotation confident on its own.
        for surface, zh in self.suffixes:
            if (
                stem.endswith(surface)
                and len(stem) - len(surface) >= 3
                and surface != stem
            ):
                suffix_note = "后缀 -%s(%s)" % (surface, zh)
                stem = stem[: len(stem) - len(surface)]
                break

        # Root anywhere in the remaining stem (longest match wins). A root is the
        # strongest signal; require >=4 chars so it is a real Latin/Greek root and
        # not an accidental 3-letter substring.
        for surface, zh in self.roots:
            if len(surface) >= 4 and surface in stem:
                root_note = "词根 %s(%s)" % (surface, zh)
                matched_root = True
                break

        # Confidence gate (no fabrication):
        #   - a real root match is always confident
        #   - a multi-letter (>=3) prefix is confident (e.g. inter-, trans-, pre-)
        #   - a SHORT (2-letter) prefix is only kept when paired with a root
        #   - a lone suffix is never enough
        if not (matched_root or matched_prefix):
            return ""

        notes = []
        # Drop a lone short prefix unless a root backs it up.
        if prefix_note and (matched_prefix or matched_root):
            if not short_prefix or matched_root:
                notes.append(prefix_note)
        if root_note:
            notes.append(root_note)
        if suffix_note and notes:
            notes.append(suffix_note)

        if not notes:
            return ""
        return " + ".join(notes)


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


def load_seed(seed_path):
    with open(seed_path, "r", encoding="utf-8") as f:
        return json.load(f)


def max_id_num(records):
    best = 0
    for r in records:
        m = re.match(r"^w(\d+)$", str(r.get("id", "")))
        if m:
            best = max(best, int(m.group(1)))
    return best


def stream_ecdict(ecdict_path):
    """Yield candidate ECDICT rows (lowercase lemma, has Chinese, not inflected)."""
    csv.field_size_limit(sys.maxsize)
    with open(ecdict_path, "r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            word = (row.get("word") or "").strip()
            if not WORD_RE.match(word):
                continue
            translation = (row.get("translation") or "").strip()
            if not translation:
                continue
            if is_inflected_form(row.get("exchange") or ""):
                continue
            yield word, row


def to_int(value):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


def build(args):
    affixes_kb = json.load(open(args.affixes, "r", encoding="utf-8"))
    annotator = AffixAnnotator(affixes_kb)

    seed = load_seed(args.seed)
    existing_by_word = {}
    for r in seed:
        w = r.get("word")
        if w:
            existing_by_word[w] = r
    next_id_num = max_id_num(seed) + 1

    # --- Pass over ECDICT: collect best row per candidate word + ranking keys ---
    # Keep one row per word (first wins; ECDICT is effectively unique per word).
    candidates = {}  # word -> row
    for word, row in stream_ecdict(args.ecdict):
        if word not in candidates:
            candidates[word] = row

    # FREQUENCY SELECTION: among candidates with frq > 0, take the top N by the
    # smallest frq (COCA rank). bnc is the tiebreak / fallback ranking key only.
    ranked = []
    for word, row in candidates.items():
        frq = to_int(row.get("frq"))
        if frq > 0:
            bnc = to_int(row.get("bnc"))
            ranked.append((frq, bnc if bnc > 0 else 10 ** 9, word))
    ranked.sort(key=lambda t: (t[0], t[1], t[2]))
    top_words = set(w for _, _, w in ranked[: args.target])

    # PROGRAMMING set: existing-tagged programming words + curated list.
    programming_words = set(PROGRAMMING_TERMS.keys())
    for w, r in existing_by_word.items():
        if "programming" in (r.get("tags") or []):
            programming_words.add(w)

    # FINAL SET = top-N freq lemmas U programming set U all existing seed words.
    final_words = set(top_words)
    final_words |= programming_words
    final_words |= set(existing_by_word.keys())

    # --- Build records ------------------------------------------------------
    out_records = []
    stats = {
        "preserved": 0,
        "new": 0,
        "with_examples": 0,
        "ra_curated": 0,
        "ra_rule": 0,
        "programming": 0,
        "freq_ranked": 0,
        "freq_min": None,
        "freq_max": None,
    }

    # Deterministic, stable ordering of the output: existing seed words first in
    # their original id order, then new words by (freq asc, word). This keeps the
    # diff readable and preserves the curated block up top.
    existing_order = [r["word"] for r in seed if r.get("word") in final_words]
    existing_set = set(existing_order)
    new_words = [w for w in final_words if w not in existing_set]

    def freq_of(word):
        row = candidates.get(word)
        return to_int(row.get("frq")) if row else 0

    new_words.sort(key=lambda w: (freq_of(w) or 10 ** 9, w))

    def make_tags(word, ecdict_row, base_tags=None):
        tags = list(base_tags or [])
        # Exam tags from ECDICT.
        if ecdict_row:
            for t in (ecdict_row.get("tag") or "").split():
                if t in EXAM_TAGS and t not in tags:
                    tags.append(t)
        # Frequency-band tag.
        band = freq_band_tag(freq_of(word))
        if band and band not in tags:
            tags.append(band)
        # Programming / cs.
        if word in programming_words:
            if "programming" not in tags:
                tags.append("programming")
            if "cs" not in tags:
                tags.append("cs")
        return tags

    def record_freq(freq):
        if freq and freq > 0:
            stats["freq_ranked"] += 1
            if stats["freq_min"] is None or freq < stats["freq_min"]:
                stats["freq_min"] = freq
            if stats["freq_max"] is None or freq > stats["freq_max"]:
                stats["freq_max"] = freq

    # Existing words (preserve id / examples / root_affix).
    for word in existing_order:
        old = existing_by_word[word]
        row = candidates.get(word)
        freq = freq_of(word)

        def_zh = old.get("def_zh") or ""
        def_en = old.get("def_en") or ""
        phonetic = old.get("phonetic") or ""
        if row:
            if not def_zh:
                def_zh = clean_def_zh(row.get("translation"))
            if not def_en:
                def_en = clean_def_en(row.get("definition"))
            if not phonetic:
                phonetic = wrap_phonetic(row.get("phonetic"))
        # Programming fallback def_zh when ECDICT missing and existing empty.
        if not def_zh and word in PROGRAMMING_TERMS:
            def_zh = PROGRAMMING_TERMS[word]

        tags = make_tags(word, row, base_tags=old.get("tags"))

        rec = {
            "id": old["id"],
            "word": word,
            "phonetic": phonetic,
            "def_zh": def_zh,
            "def_en": def_en,
            "examples": old.get("examples") or [],
            "root_affix": old.get("root_affix") or "",
            "tags": tags,
            "freq": freq,
        }
        out_records.append(rec)
        stats["preserved"] += 1
        if rec["examples"]:
            stats["with_examples"] += 1
        if rec["root_affix"]:
            stats["ra_curated"] += 1
        if word in programming_words:
            stats["programming"] += 1
        record_freq(freq)

    # New words.
    for word in new_words:
        row = candidates.get(word)
        freq = freq_of(word)

        if row:
            def_zh = clean_def_zh(row.get("translation"))
            def_en = clean_def_en(row.get("definition"))
            phonetic = wrap_phonetic(row.get("phonetic"))
        else:
            def_zh = ""
            def_en = ""
            phonetic = ""
        # Programming fallback when not in ECDICT (or empty Chinese).
        if not def_zh and word in PROGRAMMING_TERMS:
            def_zh = PROGRAMMING_TERMS[word]

        root_affix = annotator.annotate(word)
        tags = make_tags(word, row)

        rec = {
            "id": "w%04d" % next_id_num,
            "word": word,
            "phonetic": phonetic,
            "def_zh": def_zh,
            "def_en": def_en,
            "examples": [],
            "root_affix": root_affix,
            "tags": tags,
            "freq": freq,
        }
        next_id_num += 1
        out_records.append(rec)
        stats["new"] += 1
        if root_affix:
            stats["ra_rule"] += 1
        if word in programming_words:
            stats["programming"] += 1
        record_freq(freq)

    # --- Write output -------------------------------------------------------
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out_records, f, ensure_ascii=False, indent=2)
        f.write("\n")

    file_size = os.path.getsize(args.out)

    # --- Stats --------------------------------------------------------------
    total = len(out_records)
    with_ra = stats["ra_curated"] + stats["ra_rule"]
    print("=" * 60)
    print("build_vocab.py - pipeline complete")
    print("=" * 60)
    print("ECDICT candidates (lemmas, has zh): %d" % len(candidates))
    print("Frequency-ranked candidates (frq>0): %d" % len(ranked))
    print("Top-N target: %d" % args.target)
    print("-" * 60)
    print("Total words written:        %d" % total)
    print("  preserved (existing):     %d" % stats["preserved"])
    print("  new:                      %d" % stats["new"])
    print("With examples:              %d" % stats["with_examples"])
    print("With root_affix:            %d (curated %d / rule %d)"
          % (with_ra, stats["ra_curated"], stats["ra_rule"]))
    print("Programming (programming):  %d" % stats["programming"])
    print("Freq-ranked words (freq>0): %d  range [%s..%s]"
          % (stats["freq_ranked"], stats["freq_min"], stats["freq_max"]))
    print("File size:                  %.2f MB (%d bytes)"
          % (file_size / (1024 * 1024), file_size))
    print("Output:                     %s" % args.out)
    print("=" * 60)

    return 0


def parse_args(argv):
    p = argparse.ArgumentParser(description="Build the vocab PWA word dataset from ECDICT.")
    p.add_argument("--ecdict", default=DEFAULT_ECDICT, help="Path to the ECDICT CSV.")
    p.add_argument("--seed", default=DEFAULT_SEED, help="Path to the current seed-words.json.")
    p.add_argument("--out", default=DEFAULT_OUT, help="Output seed-words.json path.")
    p.add_argument("--affixes", default=DEFAULT_AFFIXES, help="Path to affixes.json KB.")
    p.add_argument("--target", type=int, default=DEFAULT_TARGET, help="Top-N COCA-ranked lemmas to import.")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if not os.path.exists(args.ecdict):
        print("ERROR: ECDICT CSV not found: %s" % args.ecdict, file=sys.stderr)
        return 2
    if not os.path.exists(args.seed):
        print("ERROR: seed file not found: %s" % args.seed, file=sys.stderr)
        return 2
    return build(args)


if __name__ == "__main__":
    raise SystemExit(main())
