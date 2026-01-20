import json
import os

def summarize_file(filepath):
    if not os.path.exists(filepath):
        print(f"File {filepath} not found")
        return None, None

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print(f"Error loading {filepath}: {e}")
        return None, None

    node_types = {}
    rel_types = {}
    
    # Handle explicit.json and knowledge-links.json format
    if isinstance(data, dict):
        nodes = data.get('nodes', {})
        edges = data.get('edges', {})
        links = data.get('links', [])
        
        if isinstance(nodes, dict):
            for n_id, n_meta in nodes.items():
                t = n_meta.get('t', n_meta.get('type', 'unknown'))
                node_types[t] = node_types.get(t, 0) + 1
                
        if isinstance(edges, dict):
            for src, target_list in edges.items():
                if isinstance(target_list, list):
                    for edge in target_list:
                        if isinstance(edge, list) and len(edge) > 1:
                            t = edge[1]
                            rel_types[t] = rel_types.get(t, 0) + 1
                        elif isinstance(edge, dict):
                            t = edge.get('relation_type', edge.get('type', 'RELATED'))
                            rel_types[t] = rel_types.get(t, 0) + 1
                            
        if isinstance(links, list):
            for link in links:
                knowledge = link.get('knowledge', [])
                for k in knowledge:
                    t = 'EXPLAIN'
                    rel_types[t] = rel_types.get(t, 0) + 1
    
    # Handle relations.json (list of objects) format
    elif isinstance(data, list):
        for rel in data:
            if isinstance(rel, dict):
                t = rel.get('relation_type', 'RELATED')
                rel_types[t] = rel_types.get(t, 0) + 1

    return node_types, rel_types

def run_summary():
    files = [
        'explicit.json',
        'knowledge-links.json',
        'data/relations.json'
    ]
    
    total_node_types = {}
    total_rel_types = {}
    
    for f in files:
        print(f"Summary for {f}:")
        nt, rt = summarize_file(f)
        if nt:
            for t, c in nt.items():
                print(f"  Node Type {t}: {c}")
                total_node_types[t] = total_node_types.get(t, 0) + c
        if rt:
            for t, c in rt.items():
                print(f"  Relation Type {t}: {c}")
                total_rel_types[t] = total_rel_types.get(t, 0) + c
        print("-" * 30)

    print("\nOVERALL SUMMARY:")
    print("Node Types:")
    for t, c in sorted(total_node_types.items()):
        print(f"  {t}: {c}")
    print("\nRelation Types:")
    for t, c in sorted(total_rel_types.items()):
        print(f"  {t}: {c}")

if __name__ == "__main__":
    run_summary()
