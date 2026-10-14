import { createVertexAccessToken } from "./vertex-access-token.factory";
import { VERTEX_ADC_SCOPES } from "./vertex-pdf-ocr.provider";

const localCredentials = Object.freeze({
  type: "authorized_user",
  client_id: "local-client.apps.googleusercontent.com",
  client_secret: "local-secret-canary",
  refresh_token: "local-refresh-canary",
});
const serviceCredentials = Object.freeze({
  type: "service_account",
  project_id: "project-719",
  client_email: "reformaflow-ocr@project-719.iam.gserviceaccount.com",
  private_key: "service-private-key-canary",
});

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
      {
        credentials: localCredentials,
        scopes: [...VERTEX_ADC_SCOPES],
      },
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
        credentials: serviceCredentials,
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
        expectedOptions.credentials,
        GoogleAuthConstructor as never,
      );
      expect(GoogleAuthConstructor).toHaveBeenCalledTimes(1);
      expect(GoogleAuthConstructor).toHaveBeenCalledWith(expectedOptions);
      const constructed = (
        GoogleAuthConstructor.mock.calls as unknown as Array<
          [Record<string, unknown>]
        >
      )[0]![0];
      expect(constructed.credentials).toBe(expectedOptions.credentials);
      expect(constructed).not.toHaveProperty("keyFilename");
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
        serviceCredentials,
        GoogleAuthConstructor as never,
      ),
    ).toThrow("VERTEX_AUTH_CONFIG_INVALID");
    expect(GoogleAuthConstructor).toHaveBeenCalledTimes(1);
  });
});
