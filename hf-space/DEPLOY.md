# Deploying hf-space/ to HuggingFace Spaces

This directory ships as a Gradio app to a HuggingFace Space. It is **not auto-deployed** on merge to ai-nexus main — push to HF Spaces is a manual step so we never publish accidentally.

## One-time setup

1. Create the Space (web UI): https://huggingface.co/new-space
   - **Owner**: `mosesy5688`
   - **Space name**: `free2aitools`
   - **License**: MIT
   - **SDK**: Gradio
   - **Hardware**: CPU basic (free tier — Space is a thin REST client, no GPU needed)
   - **Visibility**: Public
   - Final URL: https://huggingface.co/spaces/mosesy5688/free2aitools

2. Get an HF write token: https://huggingface.co/settings/tokens (scope: `write`)

3. Authenticate locally:
   ```
   pip install -U huggingface_hub
   huggingface-cli login
   ```

## Push the contents of hf-space/ to the Space

From the ai-nexus repo root:

```
git remote add hf https://huggingface.co/spaces/mosesy5688/free2aitools
git subtree push --prefix=hf-space hf main
```

The Space rebuilds automatically (~2-4 min).

### Alternative: separate hf-space repo

If subtree-push complains (uncommon — usually only on shallow clones), copy `hf-space/*` into a fresh checkout of the HF Space repo and `git push` directly.

## Post-deploy verification

1. Open https://huggingface.co/spaces/mosesy5688/free2aitools
2. **Recommend tab**: task=text-generation, max_vram=16, max_params=70 → confirm 5 ranked recs with rationale and caveats render
3. **Search tab**: q=llama, type=model → confirm ID/Name/Type/FNI columns populated
4. **Compare tab**: paste two known IDs → confirm wide-format table with `{name} ({id[:8]})` column headers
5. **MCP Install tab**: confirm live tools/list shows 5 tools and `free2aitools_compare` description contains "Compare 2-25" (post-V27.79)

## Updating the Space after future ai-nexus changes

Re-run the subtree-push command. The Space rebuild is deterministic from `requirements.txt` + `app.py`.
