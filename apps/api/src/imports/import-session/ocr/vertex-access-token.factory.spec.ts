import { createVertexAccessToken } from "./vertex-access-token.factory";
import { VERTEX_ADC_SCOPES } from "./vertex-pdf-ocr.provider";
const credentials = {
  type: "authorized_user",
  client_id: "client",
  client_secret: "secret",
  refresh_token: "refresh",
};

describe("Vertex access-token factory", () => {
  it.each([
    [
      "LOCAL_ADC",
      {
        state: "OCR_ENABLED",
        authMode: "local-adc",
        authTrace: "LOCAL_ADC",
        projectId: "project-719",
      },
      { credentials, scopes: [...VERTEX_ADC_SCOPES] },
    ],
    [
      "SERVICE_ACCOUNT_FILE_ADC",
      {
        state: "OCR_ENABLED",
        authMode: "service-account-file",
        authTrace: "SERVICE_ACCOUNT_FILE_ADC",
        projectId: "project-719",
      },
      {
        credentials,
        scopes: [...VERTEX_ADC_SCOPES],
      },
    ],
  ] as const)(
    "constructs exactly one explicit GoogleAuth source for %s",
    (_trace, config, expectedOptions) => {
      const auth = {
        getClient: jest.fn(async () => ({
          getAccessToken: async () => ({ token: "token" }),
        })),
      };
      const GoogleAuthConstructor = jest.fn(() => auth);
      const token = createVertexAccessToken(
        config,
        credentials,
        GoogleAuthConstructor as never,
      );
      expect(GoogleAuthConstructor).toHaveBeenCalledTimes(1);
      expect(GoogleAuthConstructor).toHaveBeenCalledWith(expectedOptions);
      expect(token?.authTrace).toBe(_trace);
    },
  );

  it("does not construct ambient auth while OCR is disabled", () => {
    const GoogleAuthConstructor = jest.fn();
    expect(
      createVertexAccessToken(
        { state: "OCR_DISABLED" },
        null,
        GoogleAuthConstructor as never,
      ),
    ).toBeNull();
    expect(GoogleAuthConstructor).not.toHaveBeenCalled();
  });

  it("fails with a fixed code and never falls back after constructor failure", () => {
    const GoogleAuthConstructor = jest.fn(() => {
      throw new Error("secret constructor diagnostic");
    });
    expect(() =>
      createVertexAccessToken(
        {
          state: "OCR_ENABLED",
          authMode: "service-account-file",
          authTrace: "SERVICE_ACCOUNT_FILE_ADC",
          projectId: "project-719",
        },
        credentials,
        GoogleAuthConstructor as never,
      ),
    ).toThrow("VERTEX_AUTH_CONFIG_INVALID");
    expect(GoogleAuthConstructor).toHaveBeenCalledTimes(1);
  });
});
