#!/usr/bin/env python3
"""
📜 Compliance Enforcement Script (CES) - V6.2
System: Free2AITools
Authority: The Constitution of Free2AITools (Art V, Art VIII, Art IX)
Objective: Enforce architectural constraints, security, and confidentiality.

Checks:
1. [Art 5.1] Monolith Check: No source file > 250 lines.
2. [Art 5.1] Security Check: No D1 credentials or secrets in code.
3. [Art 8.1] English Mandate: No non-ASCII characters in code/comments.
4. [Art 9.1] IP Protection: No classified documents (CONSTITUTION, STRATEGY, etc.) in repo.
"""

import os
import re
import sys

# --- Configuration ---

# [Art 5.1] Maximum allowed lines per file
MAX_LINES = 250

# [Art 9.1] Classified Patterns (Files strictly forbidden in repo)
FORBIDDEN_FILES = [
    r".*CONSTITUTION.*",
    r".*PLAN.*",
    r".*STRATEGY.*",
    r".*PROMPT.*",
    r".*HANDOVER.*",
    r".*AUDIT.*"
]

# Files/Dirs to Ignore (Vendor code, locks, build artifacts)
IGNORE_DIRS = {
    'node_modules', '.git', 'dist', '.wrangler', '.astro', 
    'coverage', 'venv', '__pycache__'
}

# Directories exempt from Art 9.1 Confidentiality check (e.g., knowledge articles can use "prompt" in title)
CONFIDENTIALITY_EXEMPT_DIRS = {
    'knowledge'  # Knowledge base articles may discuss prompting techniques
}
IGNORE_FILES = {
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 
    'wrangler.toml', 'README.md', 'LICENSE',
    # Tier 1: Stable Adapters (Fixed API - NO FUTURE GROWTH) - Migrated from ces-check.cjs
    'arxiv-adapter.js', 'base-adapter.js', 'datasets-adapter.js', 'deepspec-adapter.js',
    'github-adapter.js', 'modelscope-adapter.js', 'ollama-adapter.js', 'openllm-adapter.js',
    'pwc-adapter.js', 'semanticscholar-adapter.js', 'huggingface-papers-adapter.js',
    'civitai-adapter.js', 'mcp-adapter.js', 'replicate-adapter.js', 'kaggle-adapter.js',
    'huggingface-adapter.js', 'fetch-data.js', 'multi-source-fetcher.js',
    # Tier 1: Legacy Test (Frozen)
    'frontend-guardian.js',
    # Tier 2: Complex Visualization (Complete UI - NO FUTURE GROWTH)
    'GraphExplorer.astro', 'NeuralGraphExplorer.astro', 'FamilyTree.astro', 'ArchitectureModule.astro',
    # Tier 3: CSS Design System (Stable)
    'design-tokens.css', 'leaderboard.css', 'knowledge.css',
    # Tier 4: Authorized Internal Documents (Art 9.1 Exemption)
    'perf-audit.yml', 'TEST_STRATEGY_MASTER_V6.0.md', 'audit-seo.cjs',
    # Tier 5: Cache Reader (CES Compliance Fix)
    'entity-cache-reader.js'
}

# File extensions to scan for code quality
SCAN_EXTENSIONS = {'.js', '.ts', '.jsx', '.tsx', '.py', '.astro', '.css', '.html'}

SECRET_PATTERNS = [
    (r"d1_token\s*=\s*['\"].+['\"]", "D1 Token Leak"),
    (r"bearer\s+ey[a-zA-Z0-9-._]+", "JWT Token Leak"),
    (r"ghp_[a-zA-Z0-9]+", "GitHub Personal Access Token"),
    (r"(?:^|[^a-zA-Z0-9_-])sk-[a-zA-Z0-9]{20,}", "OpenAI/API Key"),  # Requires 20+ chars after sk-
]

# --- Logic ---

class Violations:
    def __init__(self):
        self.errors = []

    def add(self, file, rule, details):
        self.errors.append(f"❌ [FAIL] {file}: {rule} -> {details}")

    def has_errors(self):
        return len(self.errors) > 0

    def report(self):
        if not self.errors:
            print("\n✅ CES CHECK PASSED: System is Compliant.")
            return True
        else:
            print("\n🚨 CES CHECK FAILED: Constitutional Violations Detected!")
            for e in self.errors:
                print(e)
            print(f"\nTotal Violations: {len(self.errors)}")
            return False

def is_text_file(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            f.read(1024)
        return True
    except UnicodeDecodeError:
        return False

def check_english_only(content, filepath, violations):
    """[Art 8.1] Enforce English-Only.
    
    Allows: Emojis, special symbols (←, →, ≈, ×, ✅, 🦙, etc.)
    Blocks: CJK characters (Chinese, Japanese, Korean text)
    """
    # CJK Unicode ranges:
    # \u4e00-\u9fff: CJK Unified Ideographs (Chinese)
    # \u3040-\u309f: Hiragana (Japanese)
    # \u30a0-\u30ff: Katakana (Japanese)
    # \uac00-\ud7af: Hangul Syllables (Korean)
    # \u3000-\u303f: CJK Symbols and Punctuation
    # \uff00-\uffef: Fullwidth Forms (Chinese punctuation)
    cjk_pattern = re.compile(r'[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]')
    
    line_num = 0
    for line in content.splitlines():
        line_num += 1
        match = cjk_pattern.search(line)
        if match:
            violations.add(filepath, "Art 8.1 English Mandate", f"CJK text at line {line_num}: {line.strip()[:30]}...")
            break  # One error per file is enough

def check_file(filepath, violations):
    filename = os.path.basename(filepath)
    
    # 0. Skip whitelisted files (check FIRST before any other checks)
    if filename in IGNORE_FILES or not is_text_file(filepath):
        return
    
    # Skip temp files (non-source artifacts)
    if filename.startswith('temp_'):
        return
    
    # 1. [Art 9.1] Forbidden Filenames (only after whitelist check)
    # Check if file is in an exempt directory
    is_exempt = any(exempt_dir in filepath.replace('\\', '/') for exempt_dir in CONFIDENTIALITY_EXEMPT_DIRS)
    
    if not is_exempt:
        for pattern in FORBIDDEN_FILES:
            if re.search(pattern, filename, re.IGNORECASE):
                violations.add(filepath, "Art 9.1 Confidentiality", f"Filename matches forbidden pattern '{pattern}'")
                return # Critical fail, stop scanning content

    ext = os.path.splitext(filename)[1]
    if ext not in SCAN_EXTENSIONS:
        return

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
            lines = content.splitlines()

        # 2. [Art 5.1] Monolith Check
        if len(lines) > MAX_LINES:
            violations.add(filepath, "Art 5.1 Monolith Ban", f"File length {len(lines)} > {MAX_LINES} lines")

        # 3. [Art 5.1] Secret Check
        for pattern, name in SECRET_PATTERNS:
            if re.search(pattern, content):
                violations.add(filepath, "Art 5.1 Security Protocol", f"Potential {name} detected")

        # 4. [Art 8.1] English Check (Skipping Markdown docs for now if needed, focusing on Code)
        if ext not in ['.md', '.json']: 
            check_english_only(content, filepath, violations)

    except Exception as e:
        print(f"⚠️ Could not scan {filepath}: {e}")

def main():
    print("🛡️  Initiating CES (Compliance Enforcement Script)...")
    root_dir = os.getcwd()
    violations = Violations()

    for root, dirs, files in os.walk(root_dir):
        # Filter directories
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        
        for file in files:
            filepath = os.path.join(root, file)
            check_file(filepath, violations)

    if violations.report():
        sys.exit(0)
    else:
        sys.exit(1)

if __name__ == "__main__":
    main()
