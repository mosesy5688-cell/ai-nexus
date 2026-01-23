// src/utils/seo-schema.js
/**
 * SEO JSON-LD Schema Builder
 * Constitution V4.3.2 Compliant
 * 
 * Generates structured data for:
 * - WebSite (with SearchAction)
 * - Organization
 * - BreadcrumbList
 * - SoftwareApplication (for model pages)
 */

const SITE_URL = 'https://free2aitools.com';
const SITE_NAME = 'Free AI Tools';
const SITE_DESCRIPTION = 'The open-source AI knowledge hub. Discover, explore, and compare AI models with our transparent Fair Nexus Index.';

/**
 * Build JSON-LD for Homepage
 * @returns {object} - JSON-LD schema
 */
export function buildIndexSEO() {
    return {
        '@context': 'https://schema.org',
        '@graph': [
            // WebSite with SearchAction
            {
                '@type': 'WebSite',
                '@id': `${SITE_URL}/#website`,
                'url': SITE_URL,
                'name': SITE_NAME,
                'description': SITE_DESCRIPTION,
                'publisher': { '@id': `${SITE_URL}/#organization` },
                'potentialAction': {
                    '@type': 'SearchAction',
                    'target': {
                        '@type': 'EntryPoint',
                        'urlTemplate': `${SITE_URL}/explore?q={search_term_string}`
                    },
                    'query-input': 'required name=search_term_string'
                }
            },
            // Organization
            {
                '@type': 'Organization',
                '@id': `${SITE_URL}/#organization`,
                'name': SITE_NAME,
                'url': SITE_URL,
                'logo': {
                    '@type': 'ImageObject',
                    'url': `${SITE_URL}/favicon.svg`,
                    'width': 512,
                    'height': 512
                },
                'sameAs': [
                    'https://github.com/mosesy5688-cell/ai-nexus'
                ]
            },
            // BreadcrumbList (Home only)
            {
                '@type': 'BreadcrumbList',
                'itemListElement': [
                    {
                        '@type': 'ListItem',
                        'position': 1,
                        'name': 'Home',
                        'item': SITE_URL
                    }
                ]
            }
        ]
    };
}

/**
 * Build JSON-LD for Model Detail Page
 * @param {object} model - Model data
 * @returns {object} - JSON-LD schema
 */
export function buildModelSEO(model) {
    if (!model) return null;

    const modelUrl = `${SITE_URL}/model/${model.slug || model.umid || model.id}`;
    const modelName = model.name || model.canonical_name || 'AI Model';
    const modelDesc = model.seo_summary || model.description || 'Open-source AI model';

    return {
        '@context': 'https://schema.org',
        '@graph': [
            // SoftwareApplication
            {
                '@type': 'SoftwareApplication',
                '@id': `${modelUrl}/#software`,
                'name': modelName,
                'description': modelDesc,
                'url': modelUrl,
                'applicationCategory': 'Artificial Intelligence',
                'operatingSystem': 'Any',
                'offers': {
                    '@type': 'Offer',
                    'price': '0',
                    'priceCurrency': 'USD'
                },
                'author': {
                    '@type': 'Person',
                    'name': model.author || 'Unknown'
                },
                'aggregateRating': model.fni_score ? {
                    '@type': 'AggregateRating',
                    'ratingValue': model.fni_score,
                    'bestRating': 100,
                    'worstRating': 0,
                    'ratingCount': model.likes || 1
                } : undefined
            },
            // BreadcrumbList
            {
                '@type': 'BreadcrumbList',
                'itemListElement': [
                    {
                        '@type': 'ListItem',
                        'position': 1,
                        'name': 'Home',
                        'item': SITE_URL
                    },
                    {
                        '@type': 'ListItem',
                        'position': 2,
                        'name': 'Models',
                        'item': `${SITE_URL}/explore`
                    },
                    {
                        '@type': 'ListItem',
                        'position': 3,
                        'name': modelName,
                        'item': modelUrl
                    }
                ]
            }
        ]
    };
}

/**
 * Build JSON-LD for Leaderboard/Ranking pages
 * @param {string} pageType - 'leaderboard' or 'ranking'
 * @returns {object} - JSON-LD schema
 */
export function buildListPageSEO(pageType) {
    const pageUrl = `${SITE_URL}/${pageType}`;
    const pageName = pageType === 'leaderboard' ? 'AI Model Benchmark Leaderboard' : 'AI Model Rankings';

    return {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'CollectionPage',
                '@id': `${pageUrl}/#page`,
                'name': pageName,
                'url': pageUrl,
                'isPartOf': { '@id': `${SITE_URL}/#website` }
            },
            {
                '@type': 'BreadcrumbList',
                'itemListElement': [
                    {
                        '@type': 'ListItem',
                        'position': 1,
                        'name': 'Home',
                        'item': SITE_URL
                    },
                    {
                        '@type': 'ListItem',
                        'position': 2,
                        'name': pageName,
                        'item': pageUrl
                    }
                ]
            }
        ]
    };
}

/**
 * Serialize JSON-LD to script tag
 * @param {object} schema - JSON-LD object
 * @returns {string} - HTML script tag
 */
export function renderJsonLd(schema) {
    if (!schema) return '';
    return `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
}
