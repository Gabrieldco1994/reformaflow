module.exports = {
  rootDir: "../../..",
  testEnvironment: "node",
  testMatch: [
    "<rootDir>/src/imports/ocr-synth-v1/quality-closure-mechanical.red.ts",
    "<rootDir>/src/imports/ocr-synth-v1/capture-quality-closure-mechanical.red.ts",
  ],
  transform: { "^.+\\.ts$": "ts-jest" },
  moduleFileExtensions: ["ts", "js", "json"],
  maxWorkers: 1,
};
