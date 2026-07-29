/**
 * CommonJS preload entry point.
 *
 *   node --require @sonisoft/sn-credstore/preload <script>
 *   NODE_OPTIONS="--require $(sn-credstore preload-path)"
 *
 * Must be CJS: `--require` only accepts CommonJS, and the vendor `now-sdk` bin
 * is itself CJS. That constraint is the main reason this package exists
 * separately from the ESM-only consumer repos.
 *
 * Installing here rather than lazily is deliberate — the patch has to be in
 * place before the first credential call, and for a CLI that is essentially
 * immediately.
 */
const { installKeyChainShim } = require('./dist/cjs/shim/patch.js');

installKeyChainShim();
