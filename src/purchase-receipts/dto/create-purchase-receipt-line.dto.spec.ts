import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePurchaseReceiptDto } from './create-purchase-receipt.dto';
import { CreatePurchaseReceiptLineDto } from './create-purchase-receipt-line.dto';

const LINE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LOCATION_ID = '10000000-0000-4000-8000-00000000000a';

async function errorsOf(payload: Record<string, unknown>) {
  return validate(plainToInstance(CreatePurchaseReceiptLineDto, payload));
}

function strictPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
}

describe('CreatePurchaseReceiptLineDto (R2-B2: locationId)', () => {
  it('acepta locationId UUID válido', async () => {
    expect(
      await errorsOf({
        purchaseInvoiceLineId: LINE_ID,
        quantity: '1.000',
        locationId: LOCATION_ID,
      }),
    ).toHaveLength(0);
  });

  it('acepta la línea sin locationId (compatibilidad)', async () => {
    expect(
      await errorsOf({ purchaseInvoiceLineId: LINE_ID, quantity: '1.000' }),
    ).toHaveLength(0);
  });

  it('rechaza un locationId que no es UUID', async () => {
    const errors = await errorsOf({
      purchaseInvoiceLineId: LINE_ID,
      quantity: '1.000',
      locationId: 'no-es-uuid',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('locationId');
  });

  it('con el ValidationPipe global rechaza atributos de ubicación desconocidos', async () => {
    await expect(
      strictPipe().transform(
        {
          lines: [
            {
              purchaseInvoiceLineId: LINE_ID,
              quantity: '1.000',
              warehouseId: LOCATION_ID,
            },
          ],
        },
        { type: 'body', metatype: CreatePurchaseReceiptDto },
      ),
    ).rejects.toThrow();
  });

  it('el locationId va dentro de cada línea, no en la cabecera', async () => {
    await expect(
      strictPipe().transform(
        {
          locationId: LOCATION_ID,
          lines: [{ purchaseInvoiceLineId: LINE_ID, quantity: '1.000' }],
        },
        { type: 'body', metatype: CreatePurchaseReceiptDto },
      ),
    ).rejects.toThrow();
  });
});
