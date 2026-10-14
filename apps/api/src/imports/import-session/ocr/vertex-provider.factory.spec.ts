import { createConfiguredVertexPdfOcrProvider } from "./vertex-provider.factory";

describe("configured Vertex provider", () => {
  it("keeps disabled OCR non-ready without file or GoogleAuth access", async () => {
    const admitServiceAccountFile = jest.fn();
    const admitAuthorizedUserFile = jest.fn();
    const GoogleAuthClass = jest.fn();
    const provider = await createConfiguredVertexPdfOcrProvider(
      {
        IMPORT_OCR_ENABLED: "false",
        NODE_ENV: "production",
        VERTEX_AUTH_MODE: "fly-wif",
        GOOGLE_APPLICATION_CREDENTIALS: "/secret-canary",
      },
      {
        admitServiceAccountFile,
        admitAuthorizedUserFile,
        GoogleAuthClass: GoogleAuthClass as never,
      },
    );

    expect(provider.ready()).toBe(false);
    expect(admitServiceAccountFile).not.toHaveBeenCalled();
    expect(admitAuthorizedUserFile).not.toHaveBeenCalled();
    expect(GoogleAuthClass).not.toHaveBeenCalled();
  });

  it("admits the production file before constructing only that auth source", async () => {
    const calls: string[] = [];
    const releaseVerifier = jest.fn(() => {
      calls.push("release");
      return Object.freeze({ kind: "VERIFIED" as const });
    });
    const credentials = Object.freeze({
      type: "service_account" as const,
      project_id: "project-719",
      private_key_id: "key-719",
      client_email: "reformaflow-ocr@project-719.iam.gserviceaccount.com",
      private_key: "private-key-canary",
      client_id: "719",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url:
        "https://www.googleapis.com/robot/v1/metadata/x509/reformaflow-ocr",
    });
    const admitServiceAccountFile = jest.fn(async (projectId: string) => {
      calls.push(`admit:${projectId}`);
      return {
        projectId,
        credentials,
      };
    });
    const GoogleAuthClass = jest.fn(() => {
      calls.push("auth");
      return {
        getClient: async () => ({
          getAccessToken: async () => ({ token: "token" }),
        }),
      };
    });

    const provider = await createConfiguredVertexPdfOcrProvider(
      {
        IMPORT_OCR_ENABLED: "true",
        NODE_ENV: "production",
        VERTEX_AUTH_MODE: "service-account-file",
        GOOGLE_CLOUD_PROJECT: "project-719",
        OCR_RELEASE_ENVELOPE: "verified-release-envelope",
      },
      {
        releaseVerifier,
        admitServiceAccountFile,
        GoogleAuthClass: GoogleAuthClass as never,
      } as never,
    );

    expect(calls).toEqual(["release", "admit:project-719", "auth"]);
    expect(releaseVerifier).toHaveBeenCalledTimes(1);
    expect(provider.ready()).toBe(true);
    expect(GoogleAuthClass).toHaveBeenCalledTimes(1);
    expect(GoogleAuthClass).toHaveBeenCalledWith({
      credentials,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    expect(admitServiceAccountFile).toHaveBeenCalledTimes(1);
  });

  it("admits local credentials exactly once and never probes the service file", async () => {
    const credentials = Object.freeze({
      type: "authorized_user",
      client_id: "local-client.apps.googleusercontent.com",
      client_secret: "local-secret-canary",
      refresh_token: "local-refresh-canary",
    });
    const admitAuthorizedUserFile = jest.fn(async () => ({ credentials }));
    const admitServiceAccountFile = jest.fn();
    const GoogleAuthClass = jest.fn(() => ({
      getClient: async () => ({
        getAccessToken: async () => ({ token: "token" }),
      }),
    }));

    const provider = await createConfiguredVertexPdfOcrProvider(
      {
        IMPORT_OCR_ENABLED: "true",
        NODE_ENV: "development",
        VERTEX_AUTH_MODE: "local-adc",
        GOOGLE_CLOUD_PROJECT: "project-719",
      },
      {
        admitAuthorizedUserFile,
        admitServiceAccountFile,
        GoogleAuthClass: GoogleAuthClass as never,
      },
    );

    expect(provider.ready()).toBe(true);
    expect(admitAuthorizedUserFile).toHaveBeenCalledTimes(1);
    expect(admitServiceAccountFile).not.toHaveBeenCalled();
    expect(GoogleAuthClass).toHaveBeenCalledTimes(1);
    expect(GoogleAuthClass).toHaveBeenCalledWith({
      credentials,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  });

  it("does not fall back to ambient auth after file admission fails", async () => {
    const GoogleAuthClass = jest.fn();
    const releaseVerifier = jest.fn(() =>
      Object.freeze({ kind: "VERIFIED" as const }),
    );
    await expect(
      createConfiguredVertexPdfOcrProvider(
        {
          IMPORT_OCR_ENABLED: "true",
          NODE_ENV: "production",
          VERTEX_AUTH_MODE: "service-account-file",
          GOOGLE_CLOUD_PROJECT: "project-719",
          OCR_RELEASE_ENVELOPE: "verified-release-envelope",
        },
        {
          releaseVerifier,
          admitServiceAccountFile: async () => {
            throw new Error("VERTEX_SERVICE_ACCOUNT_FILE_INVALID");
          },
          GoogleAuthClass: GoogleAuthClass as never,
        } as never,
      ),
    ).rejects.toThrow("VERTEX_SERVICE_ACCOUNT_FILE_INVALID");
    expect(releaseVerifier).toHaveBeenCalledTimes(1);
    expect(GoogleAuthClass).not.toHaveBeenCalled();
  });

  it("production factory uses the real release verifier without optional DI", async () => {
    const admitServiceAccountFile = jest.fn(async () => ({
      projectId: "project-719",
      credentials: {
        type: "service_account" as const,
        project_id: "project-719",
        private_key_id: "key-719",
        client_email: "ocr@example.invalid",
        private_key: "test-only",
        client_id: "719",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url:
          "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: "https://example.invalid/cert",
      },
    }));
    const GoogleAuthClass = jest.fn();
    const factory = createConfiguredVertexPdfOcrProvider as unknown as (
      environment: Readonly<Record<string, string | undefined>>,
      dependencies: Readonly<Record<string, unknown>>,
    ) => ReturnType<typeof createConfiguredVertexPdfOcrProvider>;

    const provider = await factory(
      {
        IMPORT_OCR_ENABLED: "true",
        NODE_ENV: "production",
        VERTEX_AUTH_MODE: "service-account-file",
        GOOGLE_CLOUD_PROJECT: "project-719",
      },
      {
        admitServiceAccountFile,
        GoogleAuthClass,
      },
    );

    expect(provider.ready()).toBe(false);
    expect(admitServiceAccountFile).not.toHaveBeenCalled();
    expect(GoogleAuthClass).not.toHaveBeenCalled();
  });

  it("constructs credentials only after an exact verified release", async () => {
    const calls: string[] = [];
    const releaseVerifier = jest.fn(() => {
      calls.push("release-verifier");
      return Object.freeze({
        kind: "VERIFIED",
        algorithm: "EC_SIGN_P256_SHA256",
        activationSubjectSha256: "a".repeat(64),
      });
    });
    const parseAuthConfig = jest.fn(() => {
      calls.push("auth-config");
      return {
        state: "OCR_ENABLED",
        authMode: "service-account-file",
        projectId: "project-719",
      };
    });
    const admitServiceAccountFile = jest.fn(async () => {
      calls.push("credential-admission");
      return {
        projectId: "project-719",
        credentials: {
          type: "service_account" as const,
          project_id: "project-719",
          private_key_id: "key-719",
          client_email: "ocr@example.invalid",
          private_key: "test-only",
          client_id: "719",
          auth_uri: "https://accounts.google.com/o/oauth2/auth",
          token_uri: "https://oauth2.googleapis.com/token",
          auth_provider_x509_cert_url:
            "https://www.googleapis.com/oauth2/v1/certs",
          client_x509_cert_url: "https://example.invalid/cert",
        },
      };
    });
    const GoogleAuthClass = jest.fn(() => {
      calls.push("provider-construction");
      return {
        getClient: async () => ({
          getAccessToken: async () => ({ token: "token" }),
        }),
      };
    });
    const factory = createConfiguredVertexPdfOcrProvider as unknown as (
      environment: Readonly<Record<string, string | undefined>>,
      dependencies: Readonly<Record<string, unknown>>,
    ) => ReturnType<typeof createConfiguredVertexPdfOcrProvider>;

    const result = await factory(
      {
        IMPORT_OCR_ENABLED: "true",
        NODE_ENV: "production",
        VERTEX_AUTH_MODE: "service-account-file",
        GOOGLE_CLOUD_PROJECT: "project-719",
        OCR_RELEASE_ENVELOPE: "signed-envelope",
      },
      {
        releaseVerifier,
        parseAuthConfig,
        admitServiceAccountFile,
        GoogleAuthClass: GoogleAuthClass as never,
      },
    );

    expect(result.ready()).toBe(true);
    expect(calls).toEqual([
      "release-verifier",
      "auth-config",
      "credential-admission",
      "provider-construction",
    ]);
  });

  it.each([
    ["unsafe traversal", "../outside-api.js", "a".repeat(64)],
    [
      "unreadable launch target",
      "/definitely/missing/reformaflow-api.js",
      "a".repeat(64),
    ],
    ["actual-byte digest mismatch", __filename, "0".repeat(64)],
  ] as const)(
    "keeps production OCR OFF with OCR_RUNTIME_EXECUTABLE_MISMATCH for %s",
    async (_label, applicationEntrypointPath, executableSha256) => {
      const admitServiceAccountFile = jest.fn(async () => ({
        projectId: "project-719",
        credentials: {
          type: "service_account" as const,
          project_id: "project-719",
          private_key_id: "key-719",
          client_email: "ocr@example.invalid",
          private_key: "test-only",
          client_id: "719",
          auth_uri: "https://accounts.google.com/o/oauth2/auth",
          token_uri: "https://oauth2.googleapis.com/token",
          auth_provider_x509_cert_url:
            "https://www.googleapis.com/oauth2/v1/certs",
          client_x509_cert_url: "https://example.invalid/cert",
        },
      }));
      const GoogleAuthClass = jest.fn();
      const factory = createConfiguredVertexPdfOcrProvider as unknown as (
        environment: Readonly<Record<string, string | undefined>>,
        dependencies: Readonly<Record<string, unknown>>,
      ) => ReturnType<typeof createConfiguredVertexPdfOcrProvider>;

      const result = await factory(
        {
          IMPORT_OCR_ENABLED: "true",
          NODE_ENV: "production",
          VERTEX_AUTH_MODE: "service-account-file",
          GOOGLE_CLOUD_PROJECT: "project-719",
          OCR_RELEASE_ENVELOPE: "signed-runtime-envelope",
          OCR_APPLICATION_ENTRYPOINT_PATH: applicationEntrypointPath,
          OCR_EXECUTABLE_SHA256: executableSha256,
          OCR_RUNTIME_SUBJECT_ARTIFACT_SHA256: "b".repeat(64),
        },
        {
          admitServiceAccountFile,
          GoogleAuthClass,
        },
      );
      const observed = result as unknown as {
        ready(): boolean;
        disabledReason?: string;
      };

      expect({
        ready: observed.ready(),
        disabledReason: observed.disabledReason,
        credentialAdmissions: admitServiceAccountFile.mock.calls.length,
        authConstructions: GoogleAuthClass.mock.calls.length,
      }).toEqual({
        ready: false,
        disabledReason: "OCR_RUNTIME_EXECUTABLE_MISMATCH",
        credentialAdmissions: 0,
        authConstructions: 0,
      });
    },
  );

  it("does not let caller or environment digest overrides satisfy executable verification", async () => {
    const admitServiceAccountFile = jest.fn(async () => ({
      projectId: "project-719",
      credentials: {
        type: "service_account" as const,
        project_id: "project-719",
        private_key_id: "key-719",
        client_email: "ocr@example.invalid",
        private_key: "test-only",
        client_id: "719",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url:
          "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: "https://example.invalid/cert",
      },
    }));
    const GoogleAuthClass = jest.fn();
    const factory = createConfiguredVertexPdfOcrProvider as unknown as (
      environment: Readonly<Record<string, string | undefined>>,
      dependencies: Readonly<Record<string, unknown>>,
    ) => ReturnType<typeof createConfiguredVertexPdfOcrProvider>;
    const result = await factory(
      {
        IMPORT_OCR_ENABLED: "true",
        NODE_ENV: "production",
        VERTEX_AUTH_MODE: "service-account-file",
        GOOGLE_CLOUD_PROJECT: "project-719",
        OCR_RELEASE_ENVELOPE: "signed-runtime-envelope",
        OCR_APPLICATION_ENTRYPOINT_PATH: __filename,
        OCR_EXECUTABLE_SHA256: "f".repeat(64),
      },
      {
        executableSha256: "f".repeat(64),
        applicationEntrypointPath: __filename,
        admitServiceAccountFile,
        GoogleAuthClass,
      },
    );

    expect({
      ready: result.ready(),
      disabledReason: (result as unknown as { disabledReason?: string })
        .disabledReason,
      credentialAdmissions: admitServiceAccountFile.mock.calls.length,
      authConstructions: GoogleAuthClass.mock.calls.length,
    }).toEqual({
      ready: false,
      disabledReason: "OCR_RUNTIME_EXECUTABLE_MISMATCH",
      credentialAdmissions: 0,
      authConstructions: 0,
    });
  });
});
