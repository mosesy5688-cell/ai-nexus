#!/usr/bin/env python3
"""
L5 Sidecar Sitemap Generator - V6.1+ Scalable Sitemap System

Constitution Compliant:
- L5 Sidecar handles CPU-intensive sitemap generation
- Gzip compression for bandwidth optimization
- 45,000 URL limit per file (below Google's 50K limit)
- Uploads to R2 for edge serving

Usage:
    python l5_sitemap_gen.py

Environment Variables:
    R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
"""

import os
import gzip
import json
import boto3
from datetime import datetime
from botocore.config import Config
from l5_entity_loader import load_entities_from_r2, calculate_priority

# Configuration
MAX_URLS = 45000
BASE_URL = "https://free2aitools.com"
R2_SITEMAPS_PREFIX = "sitemaps/"

# Entity type configurations
ENTITY_CONFIGS = [
    {"type": "model", "path_prefix": "/model/", "changefreq": "weekly"},
    {"type": "dataset", "path_prefix": "/dataset/", "changefreq": "monthly"},
    {"type": "space", "path_prefix": "/space/", "changefreq": "weekly"},
    {"type": "agent", "path_prefix": "/agent/", "changefreq": "weekly"},
]

# Static pages - V12: URL-ROUTING-SPEC-V1.0 compliant
STATIC_PAGES = [
    {"path": "/", "priority": "1.0", "changefreq": "daily"},
    {"path": "/models", "priority": "0.9", "changefreq": "daily"},  # V12: New entry
    {"path": "/ranking", "priority": "0.8", "changefreq": "daily"},
    {"path": "/search", "priority": "0.8", "changefreq": "daily"},
    {"path": "/knowledge", "priority": "0.7", "changefreq": "weekly"},
    {"path": "/agent", "priority": "0.7", "changefreq": "weekly"},  # V12: Agent listing
    {"path": "/space", "priority": "0.7", "changefreq": "weekly"},  # V12: Space listing
    {"path": "/reports", "priority": "0.7", "changefreq": "weekly"},
    {"path": "/compare", "priority": "0.6", "changefreq": "weekly"},
    {"path": "/methodology", "priority": "0.5", "changefreq": "monthly"},
    {"path": "/about", "priority": "0.4", "changefreq": "monthly"},
    # Category pages
    {"path": "/text-generation", "priority": "0.8", "changefreq": "daily"},
    {"path": "/knowledge-retrieval", "priority": "0.8", "changefreq": "daily"},
    {"path": "/vision-multimedia", "priority": "0.8", "changefreq": "daily"},
    {"path": "/automation-workflow", "priority": "0.8", "changefreq": "daily"},
    {"path": "/infrastructure-ops", "priority": "0.8", "changefreq": "daily"},
]


def get_r2_client():
    """Initialize R2 client with boto3."""
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4"),
    )


def sitemap_header():
    """Generate sitemap XML header."""
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="{BASE_URL}/sitemap.xsl"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
'''


def sitemap_footer():
    """Generate sitemap XML footer."""
    return "</urlset>\n"


def sitemap_index_header():
    """Generate sitemap index XML header."""
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="{BASE_URL}/sitemap.xsl"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
'''


def sitemap_index_footer():
    """Generate sitemap index XML footer."""
    return "</sitemapindex>\n"


def generate_url_entry(loc, lastmod, priority, changefreq):
    """Generate single URL entry."""
    return f"""  <url>
    <loc>{loc}</loc>
    <lastmod>{lastmod}</lastmod>
    <changefreq>{changefreq}</changefreq>
    <priority>{priority}</priority>
  </url>
"""


def upload_to_r2(client, bucket, key, content, gzipped=False):
    """Upload content to R2."""
    content_type = "application/x-gzip" if gzipped else "application/xml"
    body = gzip.compress(content.encode("utf-8")) if gzipped else content.encode("utf-8")
    client.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type)
    print(f"  ✅ Uploaded {key}")


def generate_sitemaps():
    """Main sitemap generation function."""
    print("🗺️ L5 Sitemap Generator Starting...")
    
    client = get_r2_client()
    bucket = os.environ.get("R2_BUCKET", "ai-nexus-assets")
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ")
    
    all_sitemap_files = []
    
    # 1. Generate static pages sitemap
    print("\n📄 Generating static pages sitemap...")
    static_content = sitemap_header()
    for page in STATIC_PAGES:
        static_content += generate_url_entry(
            f"{BASE_URL}{page['path']}",
            now,
            page["priority"],
            page["changefreq"],
        )
    static_content += sitemap_footer()
    
    upload_to_r2(client, bucket, f"{R2_SITEMAPS_PREFIX}sitemap-static.xml", static_content)
    all_sitemap_files.append({"loc": f"{BASE_URL}/sitemaps/sitemap-static.xml", "lastmod": now})
    
    # 2. Load entities from R2
    print("\n📦 Loading entities from R2...")
    entities = load_entities_from_r2(client, bucket)
    
    # 3. Generate entity sitemaps by type
    for config in ENTITY_CONFIGS:
        entity_type = config["type"]
        type_entities = [e for e in entities if e["type"] == entity_type]
        
        if not type_entities:
            print(f"  ⏭️ No {entity_type} entities found, skipping...")
            continue
        
        print(f"\n🔄 Generating {entity_type} sitemaps ({len(type_entities)} entities)...")
        
        # Split into chunks
        for page_num, i in enumerate(range(0, len(type_entities), MAX_URLS), 1):
            chunk = type_entities[i:i + MAX_URLS]
            
            content = sitemap_header()
            for entity in chunk:
                content += generate_url_entry(
                    f"{BASE_URL}{config['path_prefix']}{entity['slug']}",
                    entity.get("lastmod", now)[:10],
                    calculate_priority(entity.get("fni_score")),
                    config["changefreq"],
                )
            content += sitemap_footer()
            
            filename = f"{R2_SITEMAPS_PREFIX}{entity_type}s-{page_num}.xml.gz"
            upload_to_r2(client, bucket, filename, content, gzipped=True)
            all_sitemap_files.append({
                "loc": f"{BASE_URL}/sitemaps/{entity_type}s-{page_num}.xml.gz",
                "lastmod": now,
            })
    
    # 4. Generate sitemap index
    print("\n📑 Generating sitemap index...")
    index_content = sitemap_index_header()
    for sitemap_file in all_sitemap_files:
        index_content += f"""  <sitemap>
    <loc>{sitemap_file['loc']}</loc>
    <lastmod>{sitemap_file['lastmod']}</lastmod>
  </sitemap>
"""
    index_content += sitemap_index_footer()
    
    upload_to_r2(client, bucket, f"{R2_SITEMAPS_PREFIX}sitemap-index.xml", index_content)
    
    print(f"\n🎉 Sitemap generation complete! {len(all_sitemap_files)} files created.")


if __name__ == "__main__":
    generate_sitemaps()
