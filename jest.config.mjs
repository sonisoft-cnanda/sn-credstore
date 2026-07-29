/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
    testEnvironment: 'node',
    testMatch: ['**/test/**/*.test.ts'],
    extensionsToTreatAsEsm: ['.ts'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: { module: 'ESNext', moduleResolution: 'Bundler' } }],
    },
    // Source imports carry .js extensions (required for runnable ESM output);
    // map them back to .ts so jest can resolve them.
    moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
    collectCoverageFrom: ['src/**/*.ts'],
    coverageReporters: ['text-summary', 'html'],
    testTimeout: 30_000,
};
