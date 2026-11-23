import { ImportOperationStatus, PrismaClient } from '@prisma/client';
import { E2E_ADMIN_USERNAME } from './constants';

/**
 * R4: desde R4 la API SOLO crea operaciones vinculadas a una factura de compra
 * (con referencia generada por el servidor). Las suites que prueban embarques,
 * gastos, vínculos y reportes de importaciones con el modelo ANTERIOR (líneas de
 * embarque con vínculo opcional a cualquier factura) necesitan operaciones
 * HISTÓRICAS (isLegacyUnlinked=true, sin factura principal): se crean aquí por
 * escritura directa de fixture, igual que lo haría una migración. Esas
 * operaciones siguen siendo plenamente operables por la API (compatibilidad
 * histórica), que es justo lo que estas suites verifican.
 */
export async function createLegacyImportOperation(
  prisma: PrismaClient,
  input: {
    reference: string;
    originCountry?: string;
    destinationCountry?: string;
    createdByUserId?: string;
  },
): Promise<{ id: string; reference: string; status: ImportOperationStatus }> {
  const createdByUserId =
    input.createdByUserId ??
    (
      await prisma.user.findUniqueOrThrow({
        where: { username: E2E_ADMIN_USERNAME },
        select: { id: true },
      })
    ).id;
  const created = await prisma.importOperation.create({
    data: {
      reference: input.reference,
      originCountry: input.originCountry ?? 'CN',
      destinationCountry: input.destinationCountry ?? 'PE',
      isLegacyUnlinked: true,
      purchaseInvoiceId: null,
      createdByUserId,
    },
    select: { id: true, reference: true, status: true },
  });
  return created;
}
