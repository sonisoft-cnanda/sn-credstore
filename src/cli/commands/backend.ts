/**
 * Report the active backend and probe the alternatives.
 */
import { ResolvedConfig } from '../../config.js';
import { createStore, probeAll } from '../../store/StoreFactory.js';
import { hasFlag } from '../main.js';

export async function cmdBackend(argv: string[], config: ResolvedConfig): Promise<number> {
    const json = hasFlag(argv, '--json');
    const active = createStore(config);
    const probes = await probeAll(config);

    if (json) {
        process.stdout.write(`${JSON.stringify({ active: active.id, config, probes }, null, 2)}\n`);
        return 0;
    }

    process.stdout.write(`Active backend: ${active.describe()}\n\n`);
    process.stdout.write('Available backends:\n');
    for (const p of probes) {
        const mark = p.id === active.id ? '*' : ' ';
        process.stdout.write(`${mark} ${p.id.padEnd(15)} ${p.available ? 'available' : 'unavailable'}`);
        if (p.error) process.stdout.write(`  (${p.error})`);
        process.stdout.write('\n');
    }
    process.stdout.write('\nSelect one with SN_CRED_STORE=<id>.\n');
    return 0;
}
