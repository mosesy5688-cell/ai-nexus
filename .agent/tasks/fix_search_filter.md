# Task: Fix Search and Category Filtering

## Status
- [x] Fix `src/scripts/search.js` logic for homepage search
- [x] Fix `scripts/fetch-data.js` to ensure models are tagged before saving
- [x] Improve `assignTagsToModel` to use `KEYWORD_MERGE_MAP`
- [x] Rebuild and verify data

## Notes
- `performSearch` was returning early on homepage because of missing query/tag check logic.
- `fetch-data.js` was saving models before assigning tags, leading to missing tags in frontend data.
- `assignTagsToModel` wasn't using the merge map, so synonyms like "rag" weren't mapping to category slugs.
