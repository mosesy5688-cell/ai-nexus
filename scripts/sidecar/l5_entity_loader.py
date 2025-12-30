#!/usr/bin/env python3
"""
L5 Entity Loader Module - V6.2
Loads entities from R2 for sitemap generation.
"""
import json
from datetime import datetime


def load_entities_from_r2(client, bucket):
    """Load entity data from R2 entities.json.gz (V7.1 path)."""
    entities = []
    
    try:
        response = client.get_object(Bucket=bucket, Key="ingest/current/entities.json.gz")
        body = response["Body"].read()
        
        # Decompress if gzipped
        try:
            import gzip
            data = json.loads(gzip.decompress(body).decode("utf-8"))
        except:
            data = json.loads(body.decode("utf-8"))
        
        # Handle both list and object formats
        entity_list = data if isinstance(data, list) else data.get("entities", data.get("models", []))
        
        for entity in entity_list:
            # V12 URL-ROUTING-SPEC-V1.0: Generate SEO-friendly slug
            raw_id = entity.get("id", "")
            entity_type = entity.get("type", "model")
            
            # Remove source prefix from ID (e.g., "replicate:meta/model" -> "meta/model")
            if ":" in raw_id:
                slug = raw_id.split(":", 1)[1]
            else:
                slug = raw_id
            
            # Use explicit slug if provided
            slug = entity.get("slug") or slug
            
            # Handle entity-specific slug formats per URL-ROUTING-SPEC-V1.0
            if entity_type == "agent" and slug.startswith("github-agent--"):
                # Agent: github-agent--author--name -> author/name
                parts = slug.replace("github-agent--", "").split("--")
                if len(parts) >= 2:
                    slug = f"{parts[0]}/{parts[1]}"
            elif entity_type in ("space", "dataset") and "--" in slug:
                # Space/Dataset: hf-space--author--name -> author/name
                parts = slug.split("--")
                if len(parts) >= 3:
                    slug = f"{parts[-2]}/{parts[-1]}"
            elif "--" in slug and "/" not in slug:
                # Model: huggingface--author--name -> author/name
                parts = slug.split("--")
                if len(parts) >= 2:
                    slug = f"{parts[-2]}/{parts[-1]}"
            
            if slug:
                entities.append({
                    "type": entity_type,
                    "slug": slug.lower(),  # URL-ROUTING-SPEC: always lowercase
                    "lastmod": entity.get("last_updated", entity.get("updated_at", datetime.now().isoformat())),
                    "fni_score": entity.get("fni_score"),
                })
        print(f"  📊 Loaded {len(entities)} entities from entities.json.gz")
        
    except Exception as e:
        print(f"  ⚠️ Could not load entities.json.gz: {e}")
        try:
            response = client.get_object(Bucket=bucket, Key="cache/trending.json")
            data = json.loads(response["Body"].read().decode("utf-8"))
            for model in data.get("models", []):
                entities.append({
                    "type": "model",
                    "slug": model.get("slug", model.get("id", "").replace(":", "--")),
                    "lastmod": model.get("last_updated", datetime.now().isoformat()),
                    "fni_score": model.get("fni_score"),
                })
            print(f"  📊 Fallback: Loaded {len(entities)} models from trending.json")
        except Exception as e2:
            print(f"  ❌ Could not load fallback trending.json: {e2}")
    
    return entities


def calculate_priority(fni_score):
    """Calculate sitemap priority based on FNI score."""
    if fni_score is None: return "0.5"
    if fni_score >= 90: return "0.9"
    if fni_score >= 80: return "0.8"
    if fni_score >= 60: return "0.7"
    if fni_score >= 40: return "0.6"
    return "0.5"
