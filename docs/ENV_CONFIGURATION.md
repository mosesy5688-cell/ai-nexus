# Environment Variables Configuration

## Cloudflare Configuration
```bash
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token_here
CLOUDFLARE_ACCOUNT_ID=your_account_id_here
```

## R2 Storage Configuration
```bash
R2_ACCESS_KEY_ID=your_r2_access_key_here
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key_here
```

## GitHub API Token (Required for Task 6 - GitHub Enrichment)
Generate a Personal Access Token at: https://github.com/settings/tokens

**Required scopes**: `public_repo` (read access to public repositories)

```bash
GITHUB_TOKEN=ghp_your_personal_access_token_here
```

## Google Gemini API
```bash
GEMINI_API_KEY=your_gemini_api_key_here
```

---

## Setup Instructions

1. Create a `.env` file in the project root
2. Copy the variables above
3. Replace placeholder values with your actual credentials
4. **NEVER commit `.env` to version control** (already in `.gitignore`)
