import json

with open("data/nodes.json") as f:
    nodes = json.load(f)
with open("data/edges.json") as f:
    edges = json.load(f)

node_ids = {n["id"] for n in nodes}
errors = []

for i, e in enumerate(edges):
    if e["source"] not in node_ids:
        errors.append(f"Edge {i}: unknown source '{e['source']}'")
    if e["target"] not in node_ids:
        errors.append(f"Edge {i}: unknown target '{e['target']}'")

if errors:
    for err in errors:
        print(f"ERROR: {err}")
else:
    print(f"OK — {len(nodes)} nodes, {len(edges)} edges, all references valid")