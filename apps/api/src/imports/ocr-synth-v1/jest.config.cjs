module.exports = {
  rootDir: "../../..",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/imports/ocr-synth-v1/*.spec.ts"],
  testPathIgnorePatterns: [
    "<rootDir>/src/imports/ocr-synth-v1/quality-closure.qualify.spec.ts",
  ],
  transform: { "^.+\\.ts$": "ts-jest" },
  moduleFileExtensions: ["ts", "js", "json"],
};
