module.exports = {
    rootDir: '.',
    roots: ['<rootDir>/tests'],
    testEnvironment: 'node',
    testMatch: ['**/*.test.js'],
    clearMocks: true,
    restoreMocks: true,
    verbose: false,
    watchman: false
};
