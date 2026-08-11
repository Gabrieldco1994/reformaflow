import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from "@nestjs/common";
import { UpdateInstallmentDateDto } from "./update-installment-date.dto";

const metadata: ArgumentMetadata = {
  type: "body",
  metatype: UpdateInstallmentDateDto,
  data: "",
};

describe("UpdateInstallmentDateDto no ValidationPipe real", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

  it("aceita somente índice inteiro e data YYYY-MM-DD possível", async () => {
    await expect(
      pipe.transform({ parcela: 1, data: "2026-09-20" }, metadata),
    ).resolves.toEqual(
      expect.objectContaining({ parcela: 1, data: "2026-09-20" }),
    );

    for (const body of [
      { parcela: 1.5, data: "2026-09-20" },
      { parcela: 1, data: "2026-02-30" },
      { parcela: 1, data: "2026-09-20T00:00:00.000Z" },
      { parcela: 1, data: "2026-09-20", roomId: "room-1" },
    ]) {
      await expect(pipe.transform(body, metadata)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });
});
