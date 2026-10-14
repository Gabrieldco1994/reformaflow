const path = require("node:path");

const apiRoot = path.resolve(__dirname, "../../..");

module.exports = {
  rootDir: apiRoot,
  testEnvironment: "node",
  testMatch: [
    "<rootDir>/src/imports/import-session/ocr/pdf-ocr-analyze.integration.spec.ts",
    "<rootDir>/src/imports/import-session/ocr/vertex-pdf-ocr.provider.spec.ts",
    "<rootDir>/src/imports/ocr-synth-v1/capture-live.spec.ts",
  ],
  transform: { "^.+\\.ts$": "ts-jest" },
  moduleFileExtensions: ["ts", "js", "json"],
  globalSetup: "<rootDir>/test/jest.global-setup.cjs",
  setupFiles: ["<rootDir>/../../scripts/test-db-env.cjs"],
  moduleNameMapper: {
    "^@reformaflow/domain/dist/(.*)$":
      "<rootDir>/../../packages/domain/dist/$1",
    "^@reformaflow/domain(.*)$": "<rootDir>/../../packages/domain/src$1",
  },
};
