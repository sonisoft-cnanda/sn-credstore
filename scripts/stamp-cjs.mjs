#!/usr/bin/env node
/**
 * The package is "type": "module", so every .js under dist/ is treated as ESM —
 * including the CommonJS build, which would then fail to load with
 * ERR_REQUIRE_ESM the moment `preload.cjs` requires it.
 *
 * Dropping a package.json with {"type":"commonjs"} into dist/cjs/ scopes that
 * subtree back to CJS. This is the standard dual-build stamp and it must run
 * after every CJS compile.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'dist/cjs/package.json');

await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`, 'utf8');

console.log('stamp-cjs: wrote dist/cjs/package.json {"type":"commonjs"}');
