import { FeedbackController } from './feedback.controller';

function makePrisma() {
  return { feedback: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn() } } as any;
}

describe('FeedbackController.submit', () => {
  const user = { id: 'u1', username: 'ana' };

  it('grava rating válido (1-5) junto da mensagem', async () => {
    const prisma = makePrisma();
    const controller = new FeedbackController(prisma);

    await controller.submit('tenant-1', user, 'Muito bom!', 5);

    expect(prisma.feedback.create).toHaveBeenCalledWith({
      data: { tenantId: 'tenant-1', userId: 'u1', username: 'ana', message: 'Muito bom!', rating: 5 },
    });
  });

  it('descarta rating fora do range 1-5 (grava undefined)', async () => {
    const prisma = makePrisma();
    const controller = new FeedbackController(prisma);

    await controller.submit('tenant-1', user, 'Ok', 7);

    expect(prisma.feedback.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ rating: undefined }),
    });
  });

  it('sem rating (undefined) grava normalmente sem nota', async () => {
    const prisma = makePrisma();
    const controller = new FeedbackController(prisma);

    await controller.submit('tenant-1', user, 'Sem nota');

    expect(prisma.feedback.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ rating: undefined }),
    });
  });

  it('mensagem vazia não grava nada', async () => {
    const prisma = makePrisma();
    const controller = new FeedbackController(prisma);

    const result = await controller.submit('tenant-1', user, '   ');

    expect(prisma.feedback.create).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false });
  });
});
