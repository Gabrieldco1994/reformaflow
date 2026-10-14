module.exports = {
  rootDir: "../../..",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/imports/ocr-synth-v1/*.spec.ts"],
  transform: { "^.+\\.ts$": "ts-jest" },
  moduleFileExtensions: ["ts", "js", "json"],
};
