import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { IsInt, IsString } from 'class-validator';
import {
  VALIDATION_PIPE_OPTIONS,
  createValidationPipe,
} from './validation.pipe';

/** DTO exclusivo de la prueba: no representa ninguna entidad del negocio. */
class SampleDto {
  @IsString()
  name!: string;

  @IsInt()
  quantity!: number;
}

const metadata: ArgumentMetadata = {
  type: 'body',
  metatype: SampleDto,
};

describe('createValidationPipe', () => {
  const pipe = createValidationPipe();

  it('aplica las opciones acordadas para la Fase 0', () => {
    expect(VALIDATION_PIPE_OPTIONS).toEqual({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    });
  });

  it('acepta un payload válido y lo transforma en instancia del DTO', async () => {
    const result = (await pipe.transform(
      { name: 'producto', quantity: 3 },
      metadata,
    )) as SampleDto;

    expect(result).toBeInstanceOf(SampleDto);
    expect(result).toEqual({ name: 'producto', quantity: 3 });
  });

  it('rechaza propiedades no declaradas (forbidNonWhitelisted)', async () => {
    await expect(
      pipe.transform(
        { name: 'producto', quantity: 3, isAdmin: true },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no convierte tipos de forma implícita (enableImplicitConversion: false)', async () => {
    await expect(
      pipe.transform({ name: 'producto', quantity: '3' }, metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un payload inválido y detalla los campos afectados', async () => {
    expect.assertions(2);

    try {
      await pipe.transform({ name: 42, quantity: 'x' }, metadata);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as {
        message: string[];
      };
      expect(body.message.join(' ')).toMatch(/name|quantity/);
    }
  });
});
