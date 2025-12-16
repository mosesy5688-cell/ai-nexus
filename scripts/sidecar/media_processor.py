
import os
import time
import json
import boto3
import requests
from io import BytesIO
from botocore.config import Config
from botocore.exceptions import ClientError
from PIL import Image

# Configuration
R2_ACCESS_KEY = os.environ.get('R2_ACCESS_KEY')
R2_SECRET_KEY = os.environ.get('R2_SECRET_KEY')
R2_BUCKET = os.environ.get('R2_BUCKET')
R2_ENDPOINT = os.environ.get('R2_ENDPOINT')

MAX_PROCESSED_PER_RUN = 500

def get_r2_client():
    return boto3.client(
        's3',
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
        config=Config(signature_version='s3v4'),
        region_name='auto'  # Must be auto for R2
    )

def load_hot_index(s3):
    try:
        obj = s3.get_object(Bucket=R2_BUCKET, Key='cache/index/index_hot.json')
        content = obj['Body'].read().decode('utf-8')
        return json.loads(content)
    except Exception as e:
        print(f"❌ Failed to load index_hot.json: {e}")
        return []

def get_existing_images(s3):
    """
    V5.1.3 Art. 2.5.4 Class A Conservation Protocol:
    Use ListObjects (Class B) to build a set of existing images.
    """
    print("📋 Listing existing images in R2 (Pagination Protocol)...")
    existing = set()
    paginator = s3.get_paginator('list_objects_v2')
    
    try:
        for page in paginator.paginate(Bucket=R2_BUCKET, Prefix='images/'):
            if 'Contents' in page:
                for obj in page['Contents']:
                    existing.add(obj['Key'])
        print(f"✅ Found {len(existing)} existing images.")
        return existing
    except ClientError as e:
        print(f"❌ Failed to list objects: {e}")
        return set()

def process_and_upload(model, s3, existing_keys):
    slug = model.get('id', '').replace('/', '--')
    if not slug: 
        return False
        
    target_key = f"images/{slug}.webp"
    
    if target_key in existing_keys:
        return False

    image_url = model.get('raw_image_url') or model.get('image_url')
    if not image_url:
        return False

    print(f"🔄 Processing {slug}...")

    try:
        headers = {'User-Agent': 'Free2AITools-Sidecar/5.1.3'}
        resp = requests.get(image_url, headers=headers, timeout=10)
        if resp.status_code != 200:
            print(f"   ⚠️ Download failed: {resp.status_code}")
            return False
            
        img = Image.open(BytesIO(resp.content))
        
        if img.width > 800:
            ratio = 800 / img.width
            new_height = int(img.height * ratio)
            img = img.resize((800, new_height), Image.Resampling.LANCZOS)
            
        buffer = BytesIO()
        img.save(buffer, format="WEBP", quality=80, optimize=True)
        buffer.seek(0)
        
        s3.upload_fileobj(
            buffer, 
            R2_BUCKET, 
            target_key,
            ExtraArgs={'ContentType': 'image/webp', 'CacheControl': 'public, max-age=604800'}
        )
        print(f"   ✅ Uploaded: {target_key}")
        return True
        
    except Exception as e:
        print(f"   ❌ Error processing {slug}: {e}")
        return False

def main():
    print("🏭 Sidecar Image Factory (V5.1.3) Starting...")
    
    if not all([R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET, R2_ENDPOINT]):
        print("❌ Missing R2 Credentials")
        exit(1)
        
    s3 = get_r2_client()
    models = load_hot_index(s3)
    if not models:
        exit(0)
        
    existing_keys = get_existing_images(s3)
    
    processed_count = 0
    for model in models:
        if processed_count >= MAX_PROCESSED_PER_RUN:
            break
            
        if process_and_upload(model, s3, existing_keys):
            processed_count += 1
            
    print(f"🎉 Session Complete. Processed {processed_count} new images.")

if __name__ == "__main__":
    main()
