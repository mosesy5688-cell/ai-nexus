const DANGEROUS_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'button', 'base', 'meta', 'link']);
const EVENT_ATTR = /^on/i;

export function sanitizeHtml(html) {
    if (!html || typeof html !== 'string') return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of [...doc.querySelectorAll('*')]) {
        if (DANGEROUS_TAGS.has(el.tagName.toLowerCase())) { el.remove(); continue; }
        for (const attr of [...el.attributes]) {
            if (EVENT_ATTR.test(attr.name) || (attr.name === 'href' && attr.value.trim().toLowerCase().startsWith('javascript:'))) {
                el.removeAttribute(attr.name);
            }
        }
    }
    return doc.body.innerHTML;
}
