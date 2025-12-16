
import os
import json
import boto3
import time
from botocore.config import Config
from botocore.exceptions import ClientError

# Configuration
R2_ACCESS_KEY = os.environ.get('R2_ACCESS_KEY')
R2_SECRET_KEY = os.environ.get('R2_SECRET_KEY')
R2_BUCKET = os.environ.get('R2_BUCKET')
R2_ENDPOINT = os.environ.get('R2_ENDPOINT')

def get_r2_client():
    return boto3.client(
        's3',
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
        config=Config(signature_version='s3v4'),
        region_name='auto'
    )

def backup_index(s3):
    timestamp = int(time.time())
    source_key = 'cache/index/index_hot.json'
    dest_key = f'backups/index/index_{timestamp}.json'
    
    print(f"📦 Backing up {source_key} to {dest_key}...")
    
    try:
        s3.head_object(Bucket=R2_BUCKET, Key=source_key)
        copy_source = {'Bucket': R2_BUCKET, 'Key': source_key}
        s3.copy_object(CopySource=copy_source, Bucket=R2_BUCKET, Key=dest_key)
        print("✅ Backup successful.")
        return True
    except ClientError as e:
        print(f"❌ Backup failed: {e}")
        return False

def prune_old_backups(s3):
    print("🧹 Pruning old backups...")
    retention_cutoff = int(time.time()) - (7 * 24 * 60 * 60)
    
    paginator = s3.get_paginator('list_objects_v2')
    to_delete = []
    
    try:
        for page in paginator.paginate(Bucket=R2_BUCKET, Prefix='backups/index/'):
            if 'Contents' in page:
                for obj in page['Contents']:
                    try:
                        ts = int(obj['Key'].split('_')[-1].split('.')[0])
                        if ts < retention_cutoff:
                            to_delete.append({'Key': obj['Key']})
                    except:
                        continue
        
        if to_delete:
            print(f"🗑️ Deleting {len(to_delete)} old backups...")
            for i in range(0, len(to_delete), 1000):
                batch = to_delete[i:i+1000]
                s3.delete_objects(Bucket=R2_BUCKET, Delete={'Objects': batch})
            print("✅ Prune complete.")
        else:
            print("✨ No backups to prune.")
            
    except Exception as e:
        print(f"❌ Prune failed: {e}")

def main():
    print("🛡️ Sidecar Backup Vault (V5.1.3)...")
    if not all([R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET, R2_ENDPOINT]):
        print("❌ Missing R2 Credentials")
        exit(1)
        
    s3 = get_r2_client()
    
    if backup_index(s3):
        prune_old_backups(s3)

if __name__ == "__main__":
    main()
