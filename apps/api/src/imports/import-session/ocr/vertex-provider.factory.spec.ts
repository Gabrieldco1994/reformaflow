import { createConfiguredVertexPdfOcrProvider } from "./vertex-provider.factory";

describe("configured Vertex provider", () => {
  it("keeps disabled OCR non-ready without file or GoogleAuth access", async () => {
    const admitServiceAccountFile = jest.fn();
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
        GoogleAuthClass: GoogleAuthClass as never,
      },
    );

    expect(provider.ready()).toBe(false);
    expect(admitServiceAccountFile).not.toHaveBeenCalled();
    expect(GoogleAuthClass).not.toHaveBeenCalled();
  });

  it("admits the production file before constructing only that auth source", async () => {
    const calls: string[] = [];
    const admitServiceAccountFile = jest.fn(async (projectId: string) => {
      calls.push(`admit:${projectId}`);
      return {
        keyFilename: "/secrets/vertex-sa.json" as const,
        projectId,
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
