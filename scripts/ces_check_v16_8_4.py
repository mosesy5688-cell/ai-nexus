
import os
import sys
from check_compliance import check_file, Violations

def main():
    print("🛡️  Initiating targeted CES Check for V16.8.4...")
    violations = Violations()
    
    modified_files = [
        'src/utils/packet-loader.ts',
        'public/workers/search-worker-loader.js',
        'src/utils/mesh-routing-core.js',
        'src/utils/entity-cache-reader-core.js'
    ]
    
    root_dir = os.getcwd()
    for rel_path in modified_files:
        filepath = os.path.join(root_dir, rel_path)
        if os.path.exists(filepath):
            print(f"Checking {rel_path}...")
            check_file(filepath, violations)
        else:
            print(f"⚠️  File not found: {rel_path}")

    if violations.report():
        sys.exit(0)
    else:
        sys.exit(1)

if __name__ == "__main__":
    main()
