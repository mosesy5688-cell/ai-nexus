"""Free2AITools HF Spaces Gradio demo.

Calls the public REST API at https://free2aitools.com/api/v1/* and the MCP
JSON-RPC endpoint at https://free2aitools.com/api/mcp. No auth, no API key.
"""
import gradio as gr
import pandas as pd
import requests

API_BASE = "https://free2aitools.com/api/v1"
MCP_URL = "https://free2aitools.com/api/mcp"
TIMEOUT = 30

INSTALL_MD = """### Claude Desktop / Cursor / Windsurf

Add this to your MCP servers config (URL-based, Streamable HTTP transport):

```json
{
  "mcpServers": {
    "free2aitools": {
      "url": "https://free2aitools.com/api/mcp"
    }
  }
}
```

- Cursor: Settings > MCP Servers > Add Server > URL + Streamable HTTP
- Windsurf: Cascade > Plugins > Add MCP Server > same URL + transport
- [Install via Smithery](https://smithery.ai/servers/mosesy5688/free2aitools)
"""


def handle_response(res):
    try:
        res.raise_for_status()
        return res.json()
    except Exception as e:
        err = ""
        try:
            err = res.json().get("error", "")
        except Exception:
            err = res.text[:200] if res.text else ""
        raise gr.Error(f"API Error ({res.status_code}): {err or str(e)}")


def do_recommend(task, vram, params, limit):
    payload = {
        "task": task,
        "constraints": {"max_vram_gb": float(vram), "max_params_b": float(params)},
        "limit": int(limit),
        "explain": True,
    }
    data = handle_response(requests.post(f"{API_BASE}/select", json=payload, timeout=TIMEOUT))
    recs = data.get("recommendations", [])
    if not recs:
        return pd.DataFrame(), "No matching models found.", ""
    df = pd.DataFrame([{
        "Rank": r["rank"],
        "Name": r["name"],
        "FNI": r["fni_score"],
        "Params(B)": r.get("params_billions"),
        "VRAM(GB)": r.get("vram_estimate_gb"),
        "License": r.get("license") or "",
    } for r in recs])
    rat = "\n\n".join([f"### #{r['rank']} {r['name']}\n{r.get('rationale', '')}" for r in recs])
    cav_list = recs[0].get("caveats", []) if recs else []
    cav = "\n".join([f"- {c}" for c in cav_list]) if cav_list else "_(none)_"
    return df, rat, f"### Top-pick deployment caveats\n{cav}"


def do_search(q, t, limit):
    params = {"q": q, "limit": int(limit)}
    if t and t != "all":
        params["type"] = t
    data = handle_response(requests.get(f"{API_BASE}/search", params=params, timeout=TIMEOUT))
    results = data.get("results", [])
    return pd.DataFrame([{
        "ID": r.get("id"),
        "Name": r.get("name"),
        "Type": r.get("type"),
        "FNI": r.get("fni_score"),
    } for r in results])


def do_compare(ids_str):
    ids = [i.strip() for i in ids_str.replace("\n", ",").split(",") if i.strip()]
    if len(ids) < 2 or len(ids) > 25:
        raise gr.Error("Provide between 2 and 25 entity IDs.")
    data = handle_response(requests.get(f"{API_BASE}/compare", params={"ids": ",".join(ids)}, timeout=TIMEOUT))
    ents = data.get("entities", [])
    if not ents:
        return pd.DataFrame()

    def col_key(e):
        eid = e.get("id", "")
        return f"{e.get('name', eid)} ({eid[:8]})"

    def row(field, getter):
        return {"Field": field, **{col_key(e): getter(e) for e in ents}}

    return pd.DataFrame([
        row("FNI Score", lambda e: e.get("fni_score") if e.get("found") else "not found"),
        row("Params(B)", lambda e: e.get("specs", {}).get("params_billions", "N/A")),
        row("VRAM(GB)", lambda e: e.get("specs", {}).get("vram_estimate_gb", "N/A")),
        row("Context", lambda e: e.get("specs", {}).get("context_length", "N/A")),
        row("License", lambda e: e.get("specs", {}).get("license") or "N/A"),
        row("Type", lambda e: e.get("type", "N/A")),
    ])


def get_mcp_tools_md():
    try:
        payload = {"jsonrpc": "2.0", "method": "tools/list", "params": {}, "id": 1}
        data = handle_response(requests.post(MCP_URL, json=payload, timeout=TIMEOUT))
        tools = data.get("result", {}).get("tools", [])
    except Exception as e:
        return f"_(could not load live tools/list: {e})_"
    md = "### Live tools/list from production\n\n"
    for t in tools:
        md += f"- **`{t['name']}`** -- {t['description']}\n\n"
    return md


with gr.Blocks(title="Free2AITools", theme=gr.themes.Soft()) as demo:
    gr.Markdown("# 🎯 Free2AITools Discovery\nLive over the public REST API and MCP server at free2aitools.com. No API key.")

    with gr.Tab("🎯 Recommend"):
        gr.Markdown("Get ranked model recommendations for a task under hardware constraints. Returns rationale and deployment caveats for the top pick.")
        with gr.Row():
            task = gr.Dropdown(
                ["text-generation", "text-to-image", "image-classification", "feature-extraction", "automatic-speech-recognition"],
                label="Task",
                value="text-generation",
            )
            vram = gr.Slider(1, 80, value=16, step=1, label="Max VRAM (GB)")
            params = gr.Slider(1, 400, value=70, step=1, label="Max params (B)")
            limit = gr.Slider(1, 10, value=5, step=1, label="Number of recommendations")
        btn = gr.Button("Find models", variant="primary")
        df_out = gr.DataFrame(label="Top recommendations")
        rat_out = gr.Markdown()
        cav_out = gr.Markdown()
        btn.click(do_recommend, [task, vram, params, limit], [df_out, rat_out, cav_out])

    with gr.Tab("🔎 Search"):
        gr.Markdown("Keyword search over the Free2AITools catalog, ranked by FNI (Free2AITools Nexus Index).")
        with gr.Row():
            q = gr.Textbox(label="Query", placeholder="e.g. llama-3")
            t = gr.Dropdown(
                ["all", "model", "dataset", "paper", "agent", "space", "tool", "prompt"],
                label="Type",
                value="all",
            )
            slim = gr.Slider(1, 20, value=10, step=1, label="Limit")
        sbtn = gr.Button("Search", variant="primary")
        sout = gr.DataFrame(label="Results")
        sbtn.click(do_search, [q, t, slim], sout)

    with gr.Tab("⚖️ Compare"):
        gr.Markdown("Compare 2-25 entities side-by-side. Use IDs from the Search tab (the `ID` column).")
        ids_input = gr.Textbox(
            label="Entity IDs",
            placeholder="hf-model--meta-llama--llama-3.1-8b, hf-model--intfloat--e5-mistral-7b-instruct",
            lines=3,
        )
        cbtn = gr.Button("Compare", variant="primary")
        cout = gr.DataFrame(label="Comparison")
        cbtn.click(do_compare, ids_input, cout)

    with gr.Tab("🤖 MCP Install"):
        gr.Markdown(INSTALL_MD)
        mcp_out = gr.Markdown()
        demo.load(get_mcp_tools_md, None, mcp_out)

    gr.Markdown(
        "---\n"
        "Built with the [Free2AITools API](https://free2aitools.com) and MCP server "
        "(`https://free2aitools.com/api/mcp`). "
        "[Source](https://github.com/mosesy5688-cell/ai-nexus) - MIT license."
    )


if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860)
