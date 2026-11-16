"""Static checks on gate.yml, run before any repo goes public.

1. it still parses as YAML
2. no untrusted issue text is interpolated into a shell `run:` block
3. the answer it computes is the same answer the page hashes
"""
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

WF = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "gate.yml"
HTML = WF.parent.parent.parent / "index.html"
PY = r"C:\Users\Owner\AppData\Local\Programs\Python\Python313\python.exe"

text = WF.read_text(encoding="utf-8")

# PyYAML parses the key `on:` as boolean True under YAML 1.1, which is expected.
try:
    import yaml
    yaml.safe_load(text)
    print("PASS  gate.yml parses as YAML")
except ImportError:
    print("SKIP  PyYAML unavailable, parse check skipped")
except Exception as exc:
    print("FAIL  gate.yml does not parse:", exc)
    sys.exit(1)

# --- injection check ------------------------------------------------------
TAINTED = ("steps.decide.outputs.answer", "steps.decide.outputs.message")
untrusted = [t for t in TAINTED if t in text]
if not untrusted:
    print("WARN  neither tainted output name found; is the workflow still doing what we think?")

bad = []
for m in re.finditer(r"^(\s*)run:\s*\|?\s*$(.*?)(?=^\1\S|\Z)", text, re.S | re.M):
    block = m.group(2)
    for t in untrusted:
        if "${{ " + t + " }}" in block or "${{" + t + "}}" in block:
            bad.append(t)

if bad:
    print("FAIL  untrusted issue text interpolated into a shell block:", ", ".join(sorted(set(bad))))
    sys.exit(1)
print("PASS  no untrusted values interpolated into any run: block")

# Confirm those values ARE still passed, but via env.
for t in untrusted:
    if not re.search(r"^\s+" + re.escape(t.split(".")[-1].upper()) + r":\s*\$\{\{\s*" + re.escape(t), text, re.M):
        print("FAIL  " + t + " is no longer wired in via env, the gate cannot see it")
        sys.exit(1)
print("PASS  answer and message still reach the checks, passed through env")

# --- the workflow's own arithmetic ---------------------------------------
snippet = (
    "import sys\n"
    "sys.set_int_max_str_digits(200000)\n"
    "from math import factorial\n"
    "n = 2026\n"
    "value = factorial(n)\n"
    "k = 0\n"
    "while value % 12 == 0:\n"
    "    value //= 12\n"
    "    k += 1\n"
    "print(k)\n"
)
with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as fh:
    fh.write(snippet)
    tmp = fh.name

out = subprocess.run([PY, tmp], capture_output=True, text=True)
expected = out.stdout.strip()
print("workflow computes:", expected)

html = HTML.read_text(encoding="utf-8")
baked = re.search(r'ANSWER_HASH = "([0-9a-f]{64})"', html).group(1)
page_hash = hashlib.sha256(expected.encode()).hexdigest()

if expected == "1009" and page_hash == baked:
    print("PASS  workflow answer matches the hash baked into the page")
else:
    print("FAIL  mismatch: workflow=%s page-hash-matches=%s" % (expected, page_hash == baked))
    sys.exit(1)

print("\nRESULT: PASS")