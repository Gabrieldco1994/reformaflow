import {
  VERTEX_AUTH_STARTUP_ERROR,
  parseVertexAuthConfig,
} from "./vertex-auth.config";

const enabled = {
  IMPORT_OCR_ENABLED: "true",
  GOOGLE_CLOUD_PROJECT: "project-719",
};

describe("Vertex OCR auth configuration", () => {
  it.each([
    {},
    { IMPORT_OCR_ENABLED: "false" },
    {
      IMPORT_OCR_ENABLED: "TRUE",
      NODE_ENV: "production",
      VERTEX_AUTH_MODE: "fly-wif",
      GOOGLE_APPLICATION_CREDENTIALS: "/forbidden",
      GEMINI_API_KEY: "secret-canary",
    },
  ])(
    "keeps OCR disabled without validating auth environment",
    (environment) => {
      expect(parseVertexAuthConfig(environment)).toEqual({
        state: "OCR_DISABLED",
      });
    },
  );

  it("does not inspect any credential setting while OCR is disabled", () => {
    const environment = new Proxy(
      { IMPORT_OCR_ENABLED: "false" } as Record<string, string>,
      {
        get(target, property, receiver) {
          if (property !== "IMPORT_OCR_ENABLED")
            throw new Error(
              `credential setting was inspected: ${String(property)}`,
            );
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expect(parseVertexAuthConfig(environment)).toEqual({
      state: "OCR_DISABLED",
    });
  });

  it("admits only explicit local ADC outside production", () => {
    expect(
      parseVertexAuthConfig({
        ...enabled,
        NODE_ENV: "development",
        VERTEX_AUTH_MODE: "local-adc",
      }),
    ).toEqual({
      state: "OCR_ENABLED",
      authMode: "local-adc",
      authTrace: "LOCAL_ADC",
      projectId: "project-719",
    });
  });

  it("admits only the service-account file mode in production", () => {
    expect(
      parseVertexAuthConfig({
        ...enabled,
        NODE_ENV: "production",
        VERTEX_AUTH_MODE: "service-account-file",
      }),
    ).toEqual({
      state: "OCR_ENABLED",
      authMode: "service-account-file",
      authTrace: "SERVICE_ACCOUNT_FILE_ADC",
      projectId: "project-719",
    });
  });

  it.each([
    [{ ...enabled, NODE_ENV: "development" }],
    [{ ...enabled, NODE_ENV: "development", VERTEX_AUTH_MODE: "fly-wif" }],
    [
      {
        ...enabled,
        NODE_ENV: "development",
        VERTEX_AUTH_MODE: "local-adc",
        GOOGLE_APPLICATION_CREDENTIALS: "/forbidden-even-locally",
      },
    ],
    [
      {
        ...enabled,
        NODE_ENV: "development",
        VERTEX_AUTH_MODE: "local-adc",
        GOOGLE_API_KEY: "secret-canary",
      },
    ],
    [
      {
        ...enabled,
        NODE_ENV: "development",
        VERTEX_AUTH_MODE: "local-adc",
        GEMINI_API_KEY: "secret-canary",
      },
    ],
    [
      {
        ...enabled,
        NODE_ENV: "production",
        VERTEX_AUTH_MODE: "local-adc",
      },
    ],
    [
      {
        ...enabled,
        NODE_ENV: "production",
        VERTEX_AUTH_MODE: "fly-wif",
      },
    ],
    [
      {
        ...enabled,
        NODE_ENV: "production",
        VERTEX_AUTH_MODE: "service-account-file",
        GOOGLE_APPLICATION_CREDENTIALS: "/forbidden",
      },
    ],
    [
      {
        ...enabled,
        NODE_ENV: "production",
        VERTEX_AUTH_MODE: "service-account-file",
        VERTEX_API_KEY: "secret-canary",
      },
    ],
  ])("rejects an enabled invalid auth configuration", (environment) => {
    expect(() => parseVertexAuthConfig(environment)).toThrow(
      VERTEX_AUTH_STARTUP_ERROR,
    );
  });
});
