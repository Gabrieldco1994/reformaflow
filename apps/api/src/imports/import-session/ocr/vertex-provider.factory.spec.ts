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
      },
      {
        admitServiceAccountFile,
        GoogleAuthClass: GoogleAuthClass as never,
      },
    );

    expect(calls).toEqual(["admit:project-719", "auth"]);
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
    await expect(
      createConfiguredVertexPdfOcrProvider(
        {
          IMPORT_OCR_ENABLED: "true",
          NODE_ENV: "production",
          VERTEX_AUTH_MODE: "service-account-file",
          GOOGLE_CLOUD_PROJECT: "project-719",
        },
        {
          admitServiceAccountFile: async () => {
            throw new Error("VERTEX_SERVICE_ACCOUNT_FILE_INVALID");
          },
          GoogleAuthClass: GoogleAuthClass as never,
        },
      ),
    ).rejects.toThrow("VERTEX_SERVICE_ACCOUNT_FILE_INVALID");
    expect(GoogleAuthClass).not.toHaveBeenCalled();
  });
});
