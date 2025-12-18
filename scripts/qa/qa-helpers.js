/**
 * QA Helper Functions
 */

const HEADERS = {
    'User-Agent': 'Free2AITools-QA/1.0 (Testing; +http://free2aitools.com)',
    'Accept': 'text/html,application/json,*/*'
};

export async function testPage(config, targetUrlBase) {
    const target = `${targetUrlBase}${config.url}`;
    const start = performance.now();

    try {
        const res = await fetch(target, { headers: HEADERS });
        const duration = Math.round(performance.now() - start);
        const text = await res.text();

        const result = {
            name: config.name,
            url: config.url,
            status: res.ok ? 'PASS' : 'FAIL',
            httpStatus: res.status,
            duration: duration,
            contentLength: text.length,
            componentsFound: [],
            componentsMissing: [],
            hasJsonLd: text.includes('application/ld+json'),
            hasSsrError: res.status >= 500,
            hasHydrationError: text.includes('Hydration failed'),
            isSlow: duration > 1000,
            issues: []
        };

        // Check required components
        if (config.requiredComponents) {
            for (const comp of config.requiredComponents) {
                if (text.includes(comp)) {
                    result.componentsFound.push(comp);
                } else {
                    result.componentsMissing.push(comp);
                }
            }

            if (result.componentsMissing.length > 0) {
                result.status = 'WARN';
                result.issues.push(`Missing: ${result.componentsMissing.join(', ')}`);
            }
        }

        if (!res.ok) {
            result.status = 'FAIL';
            result.issues.push(`HTTP ${res.status} ${res.statusText}`);
        }

        if (result.hasSsrError) {
            result.status = 'FAIL';
            result.issues.push('SSR Error detected');
        }

        if (result.isSlow) {
            result.issues.push(`Slow response: ${duration}ms`);
        }

        return result;

    } catch (err) {
        return {
            name: config.name,
            url: config.url,
            status: 'FAIL',
            httpStatus: 0,
            duration: 0,
            issues: [err.message]
        };
    }
}

export async function testJson(config, targetUrlBase) {
    const target = `${targetUrlBase}${config.url}`;
    const start = performance.now();

    try {
        const res = await fetch(target, { headers: HEADERS });
        const duration = Math.round(performance.now() - start);
        const text = await res.text();

        let json = null;
        try {
            json = JSON.parse(text);
        } catch (e) {
            return {
                name: config.name,
                url: config.url,
                status: 'FAIL',
                httpStatus: res.status,
                duration: duration,
                issues: ['Invalid JSON format']
            };
        }

        const result = {
            name: config.name,
            url: config.url,
            status: 'PASS',
            httpStatus: res.status,
            duration: duration,
            recordCount: Array.isArray(json.data) ? json.data.length : (json.results?.length || 0),
            keysFound: [],
            keysMissing: [],
            issues: []
        };

        // Check required keys
        if (config.requiredKeys) {
            for (const key of config.requiredKeys) {
                if (json.hasOwnProperty(key)) {
                    result.keysFound.push(key);
                } else {
                    result.keysMissing.push(key);
                }
            }

            if (result.keysMissing.length > 0) {
                result.status = 'WARN';
                result.issues.push(`Missing keys: ${result.keysMissing.join(', ')}`);
            }
        }

        // Check min records
        if (config.minRecords && result.recordCount < config.minRecords) {
            result.status = 'WARN';
            result.issues.push(`Only ${result.recordCount} records (expected >= ${config.minRecords})`);
        }

        if (!res.ok) {
            result.status = 'FAIL';
            result.issues.push(`HTTP ${res.status}`);
        }

        return result;

    } catch (err) {
        return {
            name: config.name,
            url: config.url,
            status: 'FAIL',
            httpStatus: 0,
            issues: [err.message]
        };
    }
}

export async function testModelDetail(umid, targetUrlBase) {
    const config = {
        url: `/model/${umid}`,
        name: `Model: ${umid}`,
        requiredComponents: ['DOCTYPE', 'model', '<h1']
    };

    const result = await testPage(config, targetUrlBase);

    // Additional model-specific checks
    if (result.status !== 'FAIL') {
        // Check for "Model Not Found"
        const target = `${targetUrlBase}${config.url}`;
        const res = await fetch(target, { headers: HEADERS });
        const text = await res.text();

        if (text.includes('Model Not Found') || text.includes('not found')) {
            result.status = 'FAIL';
            result.issues.push('Model Not Found - UMID not in database');
        }

        // Check for JSON-LD SEO
        if (!text.includes('application/ld+json')) {
            result.issues.push('Missing SEO JSON-LD schema');
        }
    }

    return result;
}
