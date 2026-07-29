#!/usr/bin/env node
/**
 * `sn-credstore` CLI entry point.
 *
 * Deliberately does NOT install the shim: this tool talks to the store directly,
 * and patching the SDK here would only add a way for the two paths to disagree.
 * `doctor` reports the shim as absent for exactly this reason.
 */
import { main } from '../dist/esm/cli/main.js';

process.exitCode = await main(process.argv.slice(2));
