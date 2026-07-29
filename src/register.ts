/**
 * ESM side-effect entry point:
 *
 *     import '@sonisoft/sn-credstore/register';
 *
 * Import this FIRST in a consumer's entry point (bin/run.js, src/index.ts).
 * The patch itself does not need to beat the SDK's module load — it only needs
 * to beat the first credential call — but putting it first removes any doubt.
 *
 * Kept separate from `./index.js` on purpose: importing a library must never
 * monkeypatch a global as a side effect. Anyone wanting the API without the
 * patch imports the root; anyone wanting the patch asks for it explicitly.
 */
import { installKeyChainShim } from './shim/patch.js';

installKeyChainShim();

export {};
