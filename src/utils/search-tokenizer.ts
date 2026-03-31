/**
 * V∞ Phase 1A-γ: Search Tokenizer (SSR)
 * Porter stemmer + stop words — MUST match inverted-index-builder.js exactly.
 */

const STOP_WORDS = new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of','is','it',
    'by','with','as','be','was','are','been','from','has','had','have','that',
    'this','not','no','will','can','all','its','than','into','also','may',
    'such','when','which','where','who','how','what','would','could','should',
    'about','over','between','through','after','before','during','under','above'
]);

const STEP2: [RegExp, string][] = [
    [/ational$/, 'ate'], [/tional$/, 'tion'], [/enci$/, 'ence'],
    [/anci$/, 'ance'], [/izer$/, 'ize'], [/alli$/, 'al'],
    [/entli$/, 'ent'], [/eli$/, 'e'], [/ousli$/, 'ous'],
    [/ization$/, 'ize'], [/ation$/, 'ate'], [/ator$/, 'ate'],
    [/alism$/, 'al'], [/iveness$/, 'ive'], [/fulness$/, 'ful'],
    [/ousness$/, 'ous'], [/aliti$/, 'al'], [/iviti$/, 'ive'],
    [/biliti$/, 'ble'], [/logi$/, 'log']
];
const STEP3: [RegExp, string][] = [
    [/icate$/, 'ic'], [/ative$/, ''], [/alize$/, 'al'],
    [/iciti$/, 'ic'], [/ical$/, 'ic'], [/ful$/, ''], [/ness$/, '']
];

function porterStem(w: string): string {
    if (w.length < 3) return w;
    if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'i';
    else if (w.endsWith('sses')) w = w.slice(0, -2);
    else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) w = w.slice(0, -1);
    if (w.endsWith('eed')) { if (w.length > 4) w = w.slice(0, -1); }
    else if (w.endsWith('ed') && /[aeiou]/.test(w.slice(0, -2))) w = w.slice(0, -2);
    else if (w.endsWith('ing') && /[aeiou]/.test(w.slice(0, -3))) w = w.slice(0, -3);
    if (w.endsWith('y') && w.length > 2 && !/[aeiou]/.test(w[w.length - 2])) {
        w = w.slice(0, -1) + 'i';
    }
    for (const [re, rep] of STEP2) { if (re.test(w)) { w = w.replace(re, rep); break; } }
    for (const [re, rep] of STEP3) { if (re.test(w)) { w = w.replace(re, rep); break; } }
    if (w.endsWith('ement') && w.length > 6) w = w.slice(0, -5);
    else if (w.endsWith('ment') && w.length > 5) w = w.slice(0, -4);
    else if (w.endsWith('ent') && w.length > 4) w = w.slice(0, -3);
    else if (w.endsWith('ant') && w.length > 4) w = w.slice(0, -3);
    else if (w.endsWith('ence') && w.length > 5) w = w.slice(0, -4);
    else if (w.endsWith('ance') && w.length > 5) w = w.slice(0, -4);
    else if (w.endsWith('ible') && w.length > 5) w = w.slice(0, -4);
    else if (w.endsWith('able') && w.length > 5) w = w.slice(0, -4);
    else if (w.endsWith('ion') && w.length > 4 && /[st]/.test(w[w.length - 4])) w = w.slice(0, -3);
    else if (w.endsWith('er') && w.length > 3) w = w.slice(0, -2);
    else if (w.endsWith('ou') && w.length > 3) w = w.slice(0, -2);
    if (w.endsWith('ll') && w.length > 3) w = w.slice(0, -1);
    return w;
}

/** Tokenize query into stemmed, deduplicated terms (matching builder output) */
export function tokenizeQuery(text: string): string[] {
    if (!text) return [];
    const raw = text.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 2 && t.length <= 40 && !STOP_WORDS.has(t));
    return [...new Set(raw.map(porterStem).filter(t => t.length >= 2 && t.length <= 40))];
}

/** Get the 2-char prefix bucket for a term (matches builder bucketing) */
export function termPrefix(term: string): string {
    return term.length >= 2 ? term.slice(0, 2) : term.padEnd(2, '_');
}
