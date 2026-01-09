#!/usr/bin/env python3
"""
Kaggle Models Fetch Sidecar V14.5.2

Fetches models from Kaggle using the official kaggle CLI.
The REST API is deprecated (2025H2), so we use CLI as workaround.

Usage:
    python kaggle_models_fetch.py --limit 3000 --output ./output/kaggle_models.json

Requires:
    pip install kaggle
    KAGGLE_USERNAME and KAGGLE_KEY environment variables
"""

import argparse
import json
import subprocess
import sys
import os
from io import StringIO
import csv

def fetch_kaggle_models(limit: int = 3000, search_terms: list = None) -> list:
    """
    Fetch models from Kaggle using CLI.
    V15.0 Fix: Use sorted listings instead of search (search returns 0).
    """
    all_models = []
    seen_ids = set()
    
    # Strategy: Fetch pages sorted by different criteria to get diverse models
    sort_methods = ['hotness', 'downloadCount', 'voteCount', 'notebookCount', 'createTime']
    per_method = limit // len(sort_methods)
    
    for sort_by in sort_methods:
        if len(all_models) >= limit:
            break
            
        try:
            # Fetch without search filter, just sorted
            result = subprocess.run(
                ['kaggle', 'models', 'list', '--sort-by', sort_by, '--csv', '--page-size', '50'],
                capture_output=True,
                text=True,
                timeout=60
            )
            
            if result.returncode != 0:
                print(f"   ⚠️ Sort '{sort_by}' failed: {result.stderr.strip()}", file=sys.stderr)
                continue
                
            # Parse CSV output
            reader = csv.DictReader(StringIO(result.stdout))
            method_models = []
            
            for row in reader:
                model_id = row.get('ref') or row.get('id') or row.get('name')
                if model_id and model_id not in seen_ids:
                    seen_ids.add(model_id)
                    method_models.append({
                        'id': f'kaggle-model--{model_id.replace("/", "--")}',
                        'name': row.get('title') or model_id.split('/')[-1] if '/' in model_id else model_id,
                        'author': row.get('owner') or (model_id.split('/')[0] if '/' in model_id else 'unknown'),
                        'downloads': int(row.get('downloadCount', 0) or 0),
                        'source': 'kaggle',
                        '_entityType': 'model'
                    })
            
            print(f"   Sort '{sort_by}': {len(method_models)} models", file=sys.stderr)
            all_models.extend(method_models)
            
        except subprocess.TimeoutExpired:
            print(f"   ⚠️ Sort '{sort_by}' timed out", file=sys.stderr)
        except Exception as e:
            print(f"   ⚠️ Sort '{sort_by}' error: {e}", file=sys.stderr)
    
    print(f"   📊 Total unique models: {len(all_models)}", file=sys.stderr)
    return all_models[:limit]



def main():
    parser = argparse.ArgumentParser(description='Fetch Kaggle models via CLI')
    parser.add_argument('--limit', type=int, default=3000, help='Max models to fetch')
    parser.add_argument('--output', type=str, default='./output/kaggle_models.json', help='Output file')
    args = parser.parse_args()
    
    # Check kaggle CLI is available
    try:
        subprocess.run(['kaggle', '--version'], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("❌ kaggle CLI not found. Install with: pip install kaggle", file=sys.stderr)
        sys.exit(1)
    
    # Check credentials
    if not os.environ.get('KAGGLE_USERNAME') or not os.environ.get('KAGGLE_KEY'):
        print("⚠️ KAGGLE_USERNAME/KAGGLE_KEY not set, using ~/.kaggle/kaggle.json", file=sys.stderr)
    
    print(f"🤖 Fetching up to {args.limit} Kaggle models...", file=sys.stderr)
    models = fetch_kaggle_models(limit=args.limit)
    
    # Write output
    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(models, f, indent=2)
    
    print(f"✅ Wrote {len(models)} models to {args.output}", file=sys.stderr)
    

if __name__ == '__main__':
    main()
