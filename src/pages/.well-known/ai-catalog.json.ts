/**
 * B1-MINIMAL — ARD / ai-catalog provider manifest (protocol-compat only).
 *
 * Free2AItools is a PROVIDER / service node: it self-hosts a static-generated
 * ai-catalog manifest at /.well-known/ai-catalog.json. It is NOT an ARD registry,
 * NOT a registry-side /search, NOT a router / runtime / marketplace /
 * recommendation service. Target tier: L2 Discoverable ONLY (specVersion +
 * entries + host, served at the well-known path). No trustManifest, no
 * attestation, no L3-Trusted claim, no registry-listing / adoption claim.
 *
 * Vocabulary is grounded in the existing public surfaces (mcp.ts SERVER_BOUNDARY,
 * public/.well-known/mcp.json, src/data/llms-template.txt, openapi.json.ts) — the
 * identity + negative-boundary strings are copied so the surfaces cannot drift.
 * Content-Type: application/ai-catalog+json (ai-catalog.io canonical). URN prefix
 * urn:air: (verified against ai-catalog.io + agenticresourcediscovery.org, NOT
 * urn:ai:). MCP entry media-type application/mcp-server-card+json (canonical).
 *
 * SSR (not prerendered): the worker runs GET and sets Content-Type explicitly, so
 * `application/ai-catalog+json` actually reaches the client. A prerendered .json
 * asset would be served with an extension-derived `application/json` MIME by the
 * static host, dropping the ai-catalog media type. The body is still fully static
 * (no VFS/Factory/FNI/R2/identity read) — only the media type needs the worker.
 */
import type { APIRoute } from 'astro';

// specVersion of the ai-catalog manifest spec this document conforms to
// (ai-catalog.io: "Major.Minor", example "1.0"). JUDGMENT: the published draft
// exposes no machine-readable current version number; "1.0" is its only concrete
// example. Revise if the registry expects a different value.
const SPEC_VERSION = '1.0';

const DEFAULT_ORIGIN = 'https://free2aitools.com';

// Key identity string — VERBATIM from public/.well-known/mcp.json + llms-template
// ("structured discovery, evidence, and identity layer for AI agents"). Parity
// anchor: the conformance test asserts this exact phrase in both this manifest and
// those sources, so a future edit to one without the other fails the gate.
const IDENTITY =
    'Free2AItools is a structured discovery, evidence, and identity layer for AI ' +
    'agents: it returns FNI-ranked catalog metadata and evidence for the calling ' +
    'agent to reason over and decide on.';

// Explicit negative boundary — mirrors the mcp.json / llms.txt "What this is NOT"
// disavowals. Phrased WITHOUT any affirmative capability claim (no execute /
// router / recommendation-engine / best-model / optimal / verdict token) so the
// public copy carries only the disclaimer, never the claim.
const BOUNDARY =
    'Discovery layer only. ' + IDENTITY + ' It does not run models, does not host ' +
    'or serve tools, does no inference routing, and makes no final tool choice. It ' +
    'issues no verdict and no single-answer ranking. Hardware and framework fields ' +
    'are stored heuristics, not verified compatibility checks. Live semantic/ANN ' +
    'ranking is not currently provided. Ranking is deterministic; catalog ' +
    'placement is never bought or sold, and there is no billing. The caller ' +
    'reviews the evidence and decides.';

type Entry = {
    identifier: string;
    type: string;
    url: string;
    displayName: string;
    description: string;
    tags?: string[];
    capabilities?: string[];
    representativeQueries?: string[];
};

// Build all entries. Every entry declares identifier (urn:air:), a media-type
// `type`, and EXACTLY ONE of url/data (all use `url`). Grounded in the EXISTING
// served surfaces only — no capability that is not already public.
function buildEntries(base: string): Entry[] {
    const urn = (ns: string, name: string) => `urn:air:free2aitools.com:${ns}:${name}`;
    return [
        {
            identifier: urn('catalog', 'search'),
            type: 'application/json',
            url: `${base}/api/v1/search`,
            displayName: 'Structured discovery (keyword search)',
            description:
                'Keyword discovery over the Free2AItools catalog of AI models, ' +
                'datasets, papers, tools, and benchmarks; returns matching catalog ' +
                'metadata ranked by FNI (Free2AITools Nexus Index). Read-only; the ' +
                'calling agent reasons over the results and decides.',
            tags: ['discovery', 'search', 'models', 'datasets', 'papers', 'tools', 'benchmarks'],
            capabilities: ['keyword-discovery', 'fni-ranking'],
            representativeQueries: [
                'Find open-source code generation models',
                'Discover models for image segmentation',
                'Search the catalog for object detection datasets',
            ],
        },
        {
            identifier: urn('catalog', 'explain'),
            type: 'application/json',
            url: `${base}/api/v1/entity/{id}`,
            displayName: 'Evidence explain (FNI 5-factor breakdown)',
            description:
                'Retrieve one entity\'s FNI 5-factor evidence breakdown (Semantic, ' +
                'Authority, Popularity, Recency, Quality). Substitute {id} with an id ' +
                'returned by search (never hard-code a catalog id). Presents scoring ' +
                'evidence for the caller to interpret; issues no verdict.',
            tags: ['evidence', 'explain', 'fni'],
            capabilities: ['fni-factor-breakdown'],
            representativeQueries: [
                'Show the 5-factor FNI breakdown for one entity',
                'Explain why an entity received its FNI score',
            ],
        },
        {
            identifier: urn('catalog', 'compare'),
            type: 'application/json',
            url: `${base}/api/v1/compare`,
            displayName: 'Side-by-side compare',
            description:
                'Compare 2-25 catalog entities side-by-side with FNI factor ' +
                'decomposition and technical specs where applicable. Presents ' +
                'comparison facts for the caller to decide on; not a router, no ' +
                'recommendation on the caller\'s behalf.',
            tags: ['compare', 'evidence', 'fni'],
            capabilities: ['side-by-side-facts'],
            representativeQueries: [
                'Compare two text generation models side by side',
                'Show FNI factor differences between two image classification models',
            ],
        },
        {
            identifier: urn('catalog', 'select'),
            type: 'application/json',
            url: `${base}/api/v1/select`,
            displayName: 'Metadata filter (candidate list)',
            description:
                'Filter the catalog by declared hardware/license metadata and ' +
                'return an FNI-ranked candidate list. Constraints are metadata / ' +
                'heuristic filters over stored fields, not verified compatibility ' +
                'checks. The caller is responsible for the final selection.',
            tags: ['filter', 'candidates', 'metadata'],
            capabilities: ['metadata-filter', 'candidate-list'],
            representativeQueries: [
                'Filter code assistant models that run under 8 GB VRAM',
                'Find Apache-2.0 licensed models under 7B parameters',
            ],
        },
        {
            identifier: urn('catalog', 'discovery'),
            type: 'application/json',
            url: `${base}/api/v1/search`,
            displayName: 'Datasets / papers / benchmarks discovery',
            description:
                'Type-scoped discovery for datasets, papers, and benchmarks via the ' +
                'search surface (?type=dataset | paper | benchmark). Returns ' +
                'FNI-ranked catalog metadata for the calling agent to reason over.',
            tags: ['datasets', 'papers', 'benchmarks', 'discovery'],
            capabilities: ['typed-discovery'],
            representativeQueries: [
                'Discover public datasets for text classification',
                'Find recent papers on retrieval-augmented generation',
                'List evaluation benchmarks for reasoning',
            ],
        },
        {
            identifier: urn('catalog', 'methodology'),
            type: 'text/html',
            url: `${base}/methodology`,
            displayName: 'Methodology and transparency',
            description:
                'Human-readable methodology and transparency page: how FNI is ' +
                'computed and what the catalog does and does not assert.',
            tags: ['methodology', 'transparency', 'fni'],
            capabilities: ['transparency'],
        },
        {
            identifier: urn('api', 'openapi'),
            type: 'application/openapi+json',
            url: `${base}/openapi.json`,
            displayName: 'Free2AItools REST API (OpenAPI)',
            description:
                'OpenAPI request/response contract for the public REST API ' +
                '(/api/v1/*): search, entity evidence, compare, select, datasets, ' +
                'concepts, trends, badge, health. Machine contract for the surfaces ' +
                'above.',
            tags: ['openapi', 'rest', 'api', 'contract'],
            capabilities: ['rest-discovery', 'machine-contract'],
        },
        {
            identifier: urn('mcp', 'server'),
            type: 'application/mcp-server-card+json',
            url: `${base}/.well-known/mcp.json`,
            displayName: 'Free2AItools MCP server',
            description:
                'MCP (Model Context Protocol) server card: transport, protocol ' +
                'version, and the tool catalog (search / rank / explain / ' +
                'select_model / compare) with input schemas. The JSON-RPC endpoint ' +
                'is POST ' + base + '/api/mcp. Discovery only; no tool is run here.',
            tags: ['mcp', 'discovery', 'json-rpc'],
            capabilities: [
                'free2aitools_search', 'free2aitools_rank', 'free2aitools_explain',
                'free2aitools_select_model', 'free2aitools_compare',
            ],
            representativeQueries: [
                'Discover which AI entities exist for a topic',
                'Compare candidate models by their FNI evidence',
            ],
        },
        {
            identifier: urn('discovery', 'llms-txt'),
            type: 'text/plain',
            url: `${base}/llms.txt`,
            displayName: 'llms.txt discovery surface',
            description:
                'The llms.txt convention (llmstxt.org) discovery surface: canonical ' +
                'plain-text index of the API/MCP surfaces for autonomous agents and ' +
                'LLM-based tooling.',
            tags: ['llms-txt', 'discovery'],
            capabilities: ['agent-discovery'],
        },
    ];
}

// Pure manifest builder — imported by the conformance test (hermetic, no network).
export function buildAiCatalog(origin: string = DEFAULT_ORIGIN) {
    const base = origin.replace(/\/$/, '');
    return {
        specVersion: SPEC_VERSION,
        host: {
            displayName: 'Free2AItools',
            identifier: 'free2aitools.com',
            documentationUrl: `${base}/developers`,
            logoUrl: `${base}/favicon.svg`,
        },
        entries: buildEntries(base),
        metadata: {
            boundary: BOUNDARY,
            conformanceTier: 'L2 Discoverable',
            role: 'provider',
        },
    };
}

const HEADERS: Record<string, string> = {
    'Content-Type': 'application/ai-catalog+json',
    'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
};

export const GET: APIRoute = ({ site }) => {
    const origin = site?.href ?? DEFAULT_ORIGIN;
    const body = JSON.stringify(buildAiCatalog(origin), null, 2);
    return new Response(body, { status: 200, headers: HEADERS });
};
