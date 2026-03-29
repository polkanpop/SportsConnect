/** @type {import('jest').Config} */
module.exports = {
  // Use 'node' environment for pure logic tests — no jsdom overhead, no RN bridge needed.
  testEnvironment: 'node',

  // Match only test files under __tests__/ so Metro/Expo generated files are ignored.
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],

  // Babel-jest uses the project babel.config.js (babel-preset-expo handles TypeScript).
  transform: {
    '^.+\\.(t|j)sx?$': ['babel-jest', { configFile: './babel.config.js' }],
  },

  // Resolve the @/* path alias the same way tsconfig.json does.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },

  // Don't transform node_modules EXCEPT packages that ship raw ESM:
  // zxcvbn and zod are CJS so this list stays short.
  transformIgnorePatterns: [
    'node_modules/(?!(expo-modules-core)/)',
  ],

  // Display verbose test names in the terminal output.
  verbose: true,
};
