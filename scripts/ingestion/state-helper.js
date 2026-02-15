/**
 * Harvester State Helper (V16.4.3)
 */
import fs from 'fs';

export function loadState(stateFile) {
    try {
        if (fs.existsSync(stateFile)) {
            return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        }
    } catch (e) {
        console.warn('   ⚠️ Could not load harvest state');
    }
    return { lastRun: {}, version: '16.4.3' };
}

export function saveState(stateFile, state) {
    try {
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch (e) {
        console.warn('   ⚠️ Could not save harvest state');
    }
}
