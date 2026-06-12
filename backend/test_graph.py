from graph.queries import (
    get_all_nodes,
    get_all_edges,
    find_paths,
    get_neighbours,
    get_most_connected_nodes
)

print("=== NODES ===")
nodes = get_all_nodes()
print(f"Total: {len(nodes)} nodes")

print("\n=== EDGES ===")
edges = get_all_edges()
print(f"Total: {len(edges)} edges")

print("\n=== PATHS: fed_rate → spx ===")
paths = find_paths("fed_rate", "spx")
if paths:
    for p in paths:
        print(f"  {' → '.join(p['path'])}")
        print(f"  lag: {p['total_lag_days']} days | direction: {'+' if p['net_direction'] > 0 else '-'} | confidence: {p['avg_confidence']} | hops: {p['hop_count']}")
else:
    print("  No paths found")

print("\n=== PATHS: fed_rate → xauusd ===")
paths = find_paths("fed_rate", "xauusd")
for p in paths:
    print(f"  {' → '.join(p['path'])}")
    print(f"  lag: {p['total_lag_days']} days | direction: {'+' if p['net_direction'] > 0 else '-'} | confidence: {p['avg_confidence']}")

print("\n=== NEIGHBOURS: fed_rate ===")
neighbours = get_neighbours("fed_rate")
print(f"  Upstream: {[n['id'] for n in neighbours['upstream']]}")
print(f"  Downstream: {[n['id'] for n in neighbours['downstream']]}")

print("\n=== MOST CONNECTED NODES ===")
for n in get_most_connected_nodes(5):
    print(f"  {n['id']:20} degree={n['degree']} (in={n['in_degree']}, out={n['out_degree']})")