/**
 * Harvest CLI (argument parsing + the exit gate).
 *
 * CLI BEHAVIOUR WAS PRESERVED AFTER AN EXTRACTION/REFACTOR -- this is NOT a verbatim
 * copy, and describing it as one would be false. It was moved out of
 * harvest-single.js so that file stays under the CES 250-line ceiling while the
 * Founder-ruled completeness gate is added to it (2026-07-26 Factory 1/4 S2
 * incident). harvest-single.js remains the process entrypoint the workflow invokes
 * (`node scripts/ingestion/harvest-single.js <source>`) and delegates here.
 *
 * FACTUAL CHANGES made during the move:
 *   - `parseArgs()` was ADDED (the parsing loop was inline in main() before).
 *   - `main()` gained an `argv` PARAMETER, defaulting to process.argv.slice(2).
 *   - `c4s2Census` is now IMPORTED (it is exported from harvest-single.js).
 *   - branch/statement ORDER and COMMENTS changed.
 * Behaviour was verified equivalent; no logic was lost. The one intentional
 * behavioural WIDENING is documented on main() below: `result.error` is now also set
 * when a required source finished INCOMPLETE, so that case exits non-zero too.
 *
 * @module ingestion/harvest-cli
 */
import { harvestSingle, c4s2Census } from './harvest-single.js';

/** Parse the CLI argv tail. Unchanged semantics. */
export function parseArgs(args) {
    let sourceName = null;
    let limit = 10000;
    let chunkSize = 500;
    let skipBridge = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--limit' && args[i + 1]) {
            limit = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--chunk-size' && args[i + 1]) {
            chunkSize = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--no-bridge') {
            skipBridge = true;
        } else if (!args[i].startsWith('--') && !sourceName) {
            sourceName = args[i];
        }
    }
    return { sourceName, limit, chunkSize, skipBridge };
}

/**
 * CLI entry point.
 *
 * THE EXIT GATE (unchanged mechanism, wider coverage). A hard failure surfaced as
 * `result.error` must fail the workflow step visibly. Since the 2026-07-26 ruling
 * `result.error` is ALSO set when a REQUIRED source finished INCOMPLETE, so an
 * abandoned-work run exits 1 too: marking a required source incomplete without
 * exiting non-zero would leave the bridge and the R2 source-authority step free to
 * publish a partial harvest as complete.
 *
 * A RateLimitExceededError early-finish that still satisfied the configured limit
 * remains a non-hard, exit-0 outcome (base-adapter.js:34-36 tolerance preserved).
 */
export async function main(argv = process.argv.slice(2)) {
    if (argv[0] === 'c4s2-census') { await c4s2Census(); return; } // D-335/336 census mode
    const { sourceName, limit, chunkSize, skipBridge } = parseArgs(argv);

    if (!sourceName) {
        console.log('Usage: node harvest-single.js <source> [--limit N] [--chunk-size S] [--no-bridge]');
        process.exit(1);
    }

    const result = await harvestSingle(sourceName, { limit, chunkSize, skipBridge });

    if (result && result.error) {
        console.error(`\n❌ [Harvest] Hard failure for ${sourceName}: ${result.error}`);
        process.exit(1);
    }
}

export default { main, parseArgs };
