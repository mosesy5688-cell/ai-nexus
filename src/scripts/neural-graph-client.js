/**
 * Neural Graph Client V15.22
 * CES Compliance: Extracted from NeuralGraphExplorer.astro to honor line limits.
 */
export function initNeuralGraph(containerId) {
    const explorer = document.getElementById('neural-graph-explorer');
    if (!explorer) return;

    const panes = {
        grid: document.getElementById('pane-grid'),
        graph: document.getElementById('pane-graph')
    };
    const buttons = explorer.querySelectorAll('.view-btn');
    const hoverCard = document.getElementById('graph-hover-card');

    let graphInitialized = false;
    const isMobile = window.innerWidth < 768;

    if (isMobile) {
        panes.grid.classList.add('active');
        panes.graph.classList.remove('active');
        buttons.forEach(b => {
            if (b.dataset.view === 'grid') b.classList.add('active');
            else b.classList.remove('active');
        });
    }

    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            const view = btn.dataset.view;
            buttons.forEach(b => b.classList.toggle('active', b === btn));
            panes.grid.classList.toggle('active', view === 'grid');
            panes.graph.classList.toggle('active', view === 'graph');

            if (view === 'graph' && !graphInitialized) {
                setTimeout(initD3Graph, 100);
                graphInitialized = true;
            }
        });
    });

    async function initD3Graph() {
        const container = document.getElementById(containerId);
        const rootId = container.dataset.id;
        const loading = container.querySelector('.graph-loading');

        const normalizeId = (id) => {
            if (!id || typeof id !== 'string') return '';
            const low = id.toLowerCase();
            const segments = low.split(/--|[:/]/);
            if (low.includes('--') || low.includes(':') || low.includes('/')) {
                const first = segments[0];
                const typeHints = ['hf', 'gh', 'model', 'paper', 'agent', 'tool', 'dataset', 'space', 'arxiv', 'replicate', 'kb', 'knowledge', 'concept'];
                if (typeHints.some(p => first.includes(p))) {
                    return segments.slice(1).join('/');
                }
            }
            return low.replace(/--/g, '/').replace(/:/g, '/');
        };

        const normRootId = normalizeId(rootId);
        let nodes = JSON.parse(container.dataset.nodes || '[]');
        let links = JSON.parse(container.dataset.links || '[]');

        renderGraph({ nodes, links, normRootId, container, hoverCard, normalizeId });

        // Hydration Logic
        try {
            loading.style.display = 'flex';
            const CDN = 'https://cdn.free2aitools.com';

            // V18.12.0: Resilient fetch with .gz fallback
            const resFetch = async (url) => {
                let r = await fetch(url);
                if (!r.ok && !url.endsWith('.gz')) r = await fetch(url + '.gz');
                if (!r.ok) return null;

                if (r.url.endsWith('.gz')) {
                    const ds = new DecompressionStream('gzip');
                    const decompressedStream = r.body.pipeThrough(ds);
                    return await new Response(decompressedStream).json();
                }
                return await r.json();
            };

            const [resp1, resp2] = await Promise.all([
                resFetch(`${CDN}/cache/relations/explicit.json`),
                resFetch(`${CDN}/cache/relations/knowledge-links.json`)
            ]);

            if (resp1 || resp2) {
                const nodeSet = new Map();
                nodes.forEach(n => nodeSet.set(normalize(n.id), n));

                const processEdge = (src, tgt, type, conf) => {
                    const nSrc = normalize(src);
                    const nTgt = normalize(tgt);
                    if (nSrc === normRootId || nTgt === normRootId) {
                        if (!nodeSet.has(nSrc)) nodeSet.set(nSrc, { id: src, name: src.split(/[:\-]/).pop(), type: 'model' });
                        if (!nodeSet.has(nTgt)) nodeSet.set(nTgt, { id: tgt, name: tgt.split(/[:\-]/).pop(), type: 'model' });
                        links.push({ source: src, target: tgt, type, weight: conf });
                    }
                };

                if (resp1?.edges) Object.entries(resp1.edges).forEach(([src, edges]) => edges.forEach(e => processEdge(src, e[0], e[1], e[2])));
                nodes = Array.from(nodeSet.values());
                renderGraph({ nodes, links, normRootId, container, hoverCard });
            }
            loading.style.display = 'none';
        } catch (e) {
            console.warn('[D3] Hydration failed:', e);
            loading.style.display = 'none';
        }
    }
}

function renderGraph({ nodes, links, normRootId, container, hoverCard, normalizeId }) {
    if (typeof d3 === 'undefined') return;
    const svg = d3.select("#visual-graph");
    svg.selectAll("*").remove();
    if (!nodes.length) return;

    const width = container.clientWidth;
    const height = 400;
    const g = svg.append("g");

    const simulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(links).id(d => d.id).distance(120))
        .force("charge", d3.forceManyBody().strength(-300))
        .force("center", d3.forceCenter(width / 2, height / 2));

    const link = g.append("g").selectAll("line").data(links).join("line")
        .attr("stroke", "rgba(255, 255, 255, 0.15)").attr("stroke-width", 1.2);

    const node = g.append("g").selectAll("g").data(nodes).join("g").attr("cursor", "pointer")
        .call(d3.drag()
            .on("start", (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
            .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
            .on("end", (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
        );

    node.append("circle")
        .attr("r", d => d.id.toLowerCase().includes(normRootId) ? 14 : 8)
        .attr("fill", d => getNodeColor(d.type))
        .attr("stroke", d => d.id.toLowerCase().includes(normRootId) ? "#fff" : "none")
        .attr("stroke-width", 2);

    node.append("text").attr("dy", d => d.id.toLowerCase().includes(normRootId) ? 22 : 18)
        .attr("text-anchor", "middle").attr("class", "node-label").text(d => d.name);

    node.on("mouseenter", (e, d) => {
        hoverCard.style.display = 'block';
        hoverCard.querySelector('.card-type-tag').textContent = d.type.toUpperCase();
        hoverCard.querySelector('.card-title').textContent = d.name;
        const rect = container.getBoundingClientRect();
        hoverCard.style.left = `${e.clientX - rect.left + 15}px`;
        hoverCard.style.top = `${e.clientY - rect.top + 15}px`;
    });
    node.on("mouseleave", () => hoverCard.style.display = 'none');
    node.on("click", (e, d) => {
        const normId = normalizeId(d.id);
        let path = `/${d.type}/${normId}`;
        if (d.type === 'concept' || d.type === 'knowledge') path = `/knowledge/${normId}`;
        else if (d.type === 'paper') path = `/paper/${normId}`;
        window.location.href = path.replace(/\/+$/, '');
    });

    simulation.on("tick", () => {
        link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
        node.attr("transform", d => `translate(${d.x},${d.y})`);
    });
}

function getNodeColor(type) {
    const colors = { model: '#818cf8', paper: '#c084fc', dataset: '#4ade80', concept: '#6366f1', report: '#fbbf24' };
    return colors[type] || '#94a3b8';
}
