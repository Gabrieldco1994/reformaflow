import { createVertexAccessToken } from "./vertex-access-token.factory";
import { VERTEX_ADC_SCOPES } from "./vertex-pdf-ocr.provider";
import { VERTEX_SERVICE_ACCOUNT_KEY_PATH } from "./vertex-service-account-file";

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
      { scopes: [...VERTEX_ADC_SCOPES] },
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
        keyFilename: VERTEX_SERVICE_ACCOUNT_KEY_PATH,
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
        GoogleAuthConstructor as never,
      ),
    ).toThrow("VERTEX_AUTH_CONFIG_INVALID");
    expect(GoogleAuthConstructor).toHaveBeenCalledTimes(1);
  });
});
