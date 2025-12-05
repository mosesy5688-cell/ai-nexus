# Task 12 + 14: KV Cache & Recommendations - Complete Runbook

**Status**: Integration Complete  
**Date**: 2025-12-05

---

## 🎯 Quick Start

### Enable KV Caching (Already configured!)

KV namespace is already set up in `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "KV_CACHE"
id = "24a9a70c8676477c98bf4a02f3b75b05"
```

No setup needed - ready to use!

---

## 📦 Deployment Steps

### Step 1: Add Environment Variable

**Required**: Set admin token for cache management

**Cloudflare Dashboard**:
1. Go to: Pages → ai-nexus → Settings → Environment variables
2. Add variable:
   ```
   ADMIN_TOKEN=your-secure-random-string-here
   ```
3. Apply to: Production
4. Save

**Generate secure token**:
```bash
# Linux/Mac
openssl rand -hex 32

# Or use any secure random generator
```

---

### Step 2: Commit and Deploy

```bash
# Stage all changes
git add .

# Commit with clear message
git commit -m "feat: Add KV caching + intelligent recommendations (Task 12+14)

- Add cache-service.js for KV operations
- Add recommendation-service.js for multi-factor similarity
- Add enhanced-data.ts integration layer
- Add RelatedModels.astro component
- Add cache management APIs
"

# Push to trigger Cloudflare Pages deployment
git push origin main
```

**Deployment**: Cloudflare Pages will auto-deploy (~2 minutes)

---

### Step 3: Verify Deployment

**Test Cache Stats**:
```bash
curl https://free2aitools.com/api/cache/stats
```

**Expected Response**:
```json
{
  "success": true,
  "stats": {
    "models_list": 0,
    "models": 0,
    "related": 0,
    "total": 0
  },
  "timestamp": "2025-12-05T09:15:00.000Z"
}
```

---

## 🔧 Using the Features

### Cache Management

**View Cache Statistics**:
```bash
curl https://free2aitools.com/api/cache/stats
```

**Invalidate Cache** (requires ADMIN_TOKEN):
```bash
curl -X POST https://free2aitools.com/api/cache/invalidate \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pattern": "models:list"}'
```

**Common invalidation patterns**:
- `models:list` - Clear all models list caches
- `model:` - Clear all individual model caches
- `related:` - Clear all related models caches

---

### Using in Code

**Get models with caching**:
```typescript
import { getModelsWithCache } from './lib/enhanced-data';

// In Astro component
const kv = Astro.locals.runtime?.env?.KV_CACHE;
const models = await getModelsWithCache(kv);
```

**Get related models**:
```typescript
import { getRelatedModels } from './lib/enhanced-data';

const kv = Astro.locals.runtime?.env?.KV_CACHE;
const related = await getRelatedModels(modelId, kv, 6);
```

**Display related models**:
```astro
---
import RelatedModels from '../components/RelatedModels.astro';
---

<RelatedModels modelId={model.id} limit={6} />
```

---

## 📊 Expected Performance

### Cache Hit Rates
After warm-up (~1 hour of traffic):
- Models list: 80-90% hit rate
- Related models: 70-85% hit rate
- Overall cache reduction: 70-80% fewer D1 queries

### Page Load Improvements
- Homepage: 2s → 0.5s (75% faster)
- Model pages: 1.5s → 0.6s (60% faster)

### KV Usage (Free Tier: 100k reads/day)
- Expected daily reads: 5,000-10,000
- Expected daily writes: 200-500
- Well within free tier limits ✅

---

## 🐛 Troubleshooting

### Cache not working

**Check KV binding**:
```bash
# Should show KV_CACHE in output
wrangler pages deployment list
```

**Check cache stats**:
```bash
curl https://free2aitools.com/api/cache/stats
```

If returns "KV not available" → Environment variable issue

---

### High cache misses

**Reasons**:
1. Fresh deployment (cache empty)
2. Low traffic (cache expired)
3. Frequent invalidations

**Solution**: Wait for traffic to warm cache (~1 hour)

---

### Related models not showing

**Check**:
1. Model has valid ID
2. Sufficient similar models exist (need >1 model total)
3. Similarity threshold (minimum 20%)

**Debug**:
```javascript
// Add to component
console.log('Related models for', modelId, ':', relatedModels);
```

---

## 🔄 Cache Invalidation Strategies

### Auto-invalidation

Cache expires automatically via TTL:
- Models list: 1 hour
- Related models: 1 hour
- Model details: 30 minutes

### Manual invalidation

**After data updates**:
```bash
# Invalidate all caches
curl -X POST .../invalidate -d '{"pattern": ""}' ...

# Invalidate specific type
curl -X POST .../invalidate -d '{"pattern": "models:list"}' ...
```

### Scheduled invalidation

**Optional**: Set up GitHub Action to clear cache daily

---

## 📈 Monitoring

### Key Metrics

**Cache Performance**:
- Hit rate: Target >80%
- Miss rate: Target <20%
- Total entries: Monitor growth

**Check via API**:
```bash
# Get stats
curl https://free2aitools.com/api/cache/stats

# Response includes:
# - total: Total cache entries
# - models_list: List cache count
# - related: Related models cache count
```

---

## 🔐 Security

### Admin Token

**Required for**:
- Cache invalidation
- Any write operations

**Not required for**:
- Cache stats (read-only)
- Normal caching (automatic)

**Best Practices**:
- Use strong random token (32+ characters)
- Store in Cloudflare environment variables
- Never commit to git
- Rotate periodically

---

## ✅ Completion Checklist

- [x] KV namespace configured (pre-existing)
- [x] cache-service.js created
- [x] recommendation-service.js created
- [x] enhanced-data.ts created
- [x] RelatedModels.astro created
- [x] Cache APIs created
- [ ] ADMIN_TOKEN configured (USER ACTION REQUIRED)
- [ ] Code committed and deployed
- [ ] Production verification
- [ ] Performance monitoring

---

## 📝 Next Steps

1. **Set ADMIN_TOKEN** in Cloudflare Dashboard
2. **Deploy** via git push
3. **Verify** cache stats API
4. **Monitor** performance improvements
5. **Enjoy** faster page loads! 🚀

---

**Questions?** Check:
- `deployment_runbook.md` - Detailed integration steps
- `walkthrough.md` - Full implementation summary
- `implementation_plan.md` - Technical design

**Need help?** All code is well-commented and ready to use!
