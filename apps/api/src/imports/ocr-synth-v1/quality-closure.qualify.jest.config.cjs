module.exports = {
  rootDir: "../../..",
  testEnvironment: "node",
  testMatch: [
    "<rootDir>/src/imports/ocr-synth-v1/quality-closure.qualify.spec.ts",
  ],
  transform: { "^.+\\.ts$": "ts-jest" },
  moduleFileExtensions: ["ts", "js", "json"],
  maxWorkers: 1,
};
