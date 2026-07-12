/**
 * Security hardening: plant photo upload MIME allow-list.
 *
 * Regression guard for CVE-class stored-XSS: SVG files are valid `image/*`
 * but can embed JavaScript. The old check `startsWith('image/')` accepted them.
 * The old extension was derived from `originalname`, which is attacker-controlled.
 *
 * Rules enforced:
 *   - Only raster MIME types in PLANT_PHOTO_ALLOWED_MIMES are accepted.
 *   - Extension is derived from the MIME type, NEVER from originalname.
 *   - SVG (image/svg+xml), GIF (image/gif) and any other non-raster type → 400.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PlantService } from './plant.service';

// Mock the entire fs module so mkdirSync (called in constructor) and
// writeFileSync (called in setPhoto) can be intercepted without hitting disk.
jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
}));
import * as fs from 'fs';

// ── helpers ───────────────────────────────────────────────────────────────────

const TENANT = 'tenant-1';
const PROJECT = 'project-1';
const PLANT_ID = 'plant-abc';

/** Minimal Prisma mock – only the methods called by setPhoto. */
function makePrisma(found = true) {
  return {
    plant: {
      findFirst: jest.fn().mockResolvedValue(
        found ? { id: PLANT_ID, tenantId: TENANT, projectId: PROJECT } : null,
      ),
      update: jest.fn().mockResolvedValue({ id: PLANT_ID, fotoUrl: '/uploads/plants/x.jpg' }),
    },
  } as never;
}

function fakeFile(mimetype: string, originalname = 'photo.dat') {
  return { buffer: Buffer.from('fake'), mimetype, originalname };
}

// ── shared setup ──────────────────────────────────────────────────────────────

const writeFileSyncMock = fs.writeFileSync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.clearAllMocks();
});

// ── MIME allow-list (security) ────────────────────────────────────────────────

describe('PlantService.setPhoto – MIME allow-list', () => {
  const rejectedTypes = [
    'image/svg+xml',          // stored-XSS vector
    'image/gif',              // not raster-reuploaded by frontend compressor
    'image/tiff',             // uncommon, not in allow-list
    'image/bmp',              // not in allow-list
    'text/html',              // obvious non-image
    'application/javascript', // obvious non-image
    'application/pdf',        // document, not photo
    '',                       // empty string
  ];

  test.each(rejectedTypes)('rejects mimetype "%s" with BadRequestException', async (mime) => {
    const service = new PlantService(makePrisma());
    await expect(
      service.setPhoto(TENANT, PROJECT, PLANT_ID, fakeFile(mime)),
    ).rejects.toThrow(BadRequestException);
  });

  const acceptedTypes = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
  ];

  test.each(acceptedTypes)('accepts mimetype "%s"', async (mime) => {
    const service = new PlantService(makePrisma());
    await expect(
      service.setPhoto(TENANT, PROJECT, PLANT_ID, fakeFile(mime, 'photo.xyz')),
    ).resolves.toBeDefined();
  });
});

// ── Extension derived from MIME, not originalname ────────────────────────────

describe('PlantService.setPhoto – extension from MIME', () => {
  const cases: Array<[string, string]> = [
    ['image/jpeg', '.jpg'],
    ['image/png',  '.png'],
    ['image/webp', '.webp'],
    ['image/heic', '.heic'],
    ['image/heif', '.heif'],
  ];

  test.each(cases)(
    'mimetype %s → stored filename ends with %s (not from originalname)',
    async (mime, expectedExt) => {
      const prisma = makePrisma();
      const service = new PlantService(prisma);

      // originalname has a DIFFERENT and attacker-controlled extension
      await service.setPhoto(TENANT, PROJECT, PLANT_ID, fakeFile(mime, 'evil.svg'));

      const [[savedPath]] = (writeFileSyncMock.mock.calls as [string, Buffer][]);
      expect(savedPath).toMatch(new RegExp(`\\${expectedExt}$`));
      expect(savedPath).not.toContain('.svg');
    },
  );
});

// ── Not-found propagation ─────────────────────────────────────────────────────

describe('PlantService.setPhoto – plant not found', () => {
  it('throws NotFoundException when plant does not belong to tenant/project', async () => {
    const service = new PlantService(makePrisma(false));
    await expect(
      service.setPhoto(TENANT, PROJECT, PLANT_ID, fakeFile('image/jpeg', 'ok.jpg')),
    ).rejects.toThrow(NotFoundException);
  });
});

// ── diagnoseAndSchedule path: setPhoto inherits the guard ────────────────────
//
// This test validates that SVG fed to the diagnose-and-schedule flow (which
// calls plantService.setPhoto internally) is blocked at the setPhoto layer
// even when the caller does not re-validate MIME.

describe('PlantService.setPhoto – SVG explicitly rejected (XSS guard)', () => {
  it('throws BadRequestException for image/svg+xml regardless of originalname', async () => {
    const service = new PlantService(makePrisma());
    await expect(
      service.setPhoto(TENANT, PROJECT, PLANT_ID, {
        buffer: Buffer.from('<svg><script>alert(1)</script></svg>'),
        mimetype: 'image/svg+xml',
        originalname: 'totally-not-xss.jpg', // attacker disguises extension
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
