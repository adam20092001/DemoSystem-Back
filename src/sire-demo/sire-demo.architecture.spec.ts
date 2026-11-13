import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureTaxDocumentSource } from './sources/fixture-tax-document.source';

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return productionFiles(full);
    }
    const isTs = full.endsWith('.ts');
    const isTest =
      full.endsWith('.spec.ts') || full.endsWith('test-helpers.ts');
    return isTs && !isTest ? [full] : [];
  });
}

const ROOT = __dirname;
const files = productionFiles(ROOT);

describe('independencia del módulo SIRE DEMO respecto de la integración oficial', () => {
  it('encuentra los archivos del módulo', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no importa ningún cliente HTTP ni contiene URLs (sin comunicación posible con SUNAT)', () => {
    const forbidden = [
      /from\s+['"](axios|node-fetch|undici|got|superagent|request|http|https|node:https?|@nestjs\/axios)['"]/,
      /require\(\s*['"](axios|node-fetch|undici|got|http|https|node:https?)['"]\s*\)/,
      /\bfetch\s*\(/,
      /https?:\/\//,
      /sunat\.gob\.pe/i,
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect({ file, matches: pattern.test(text) }).toEqual({
          file,
          matches: false,
        });
      }
    }
  });

  it('el núcleo (core/) es puro: sin Nest, sin Prisma Client en servicios y sin variables de entorno', () => {
    const coreFiles = files.filter((f) => f.includes(`${join(ROOT, 'core')}`));
    expect(coreFiles.length).toBeGreaterThan(4);
    for (const file of coreFiles) {
      const text = readFileSync(file, 'utf8');
      expect({ file, nest: /@nestjs\//.test(text) }).toEqual({
        file,
        nest: false,
      });
      expect({ file, prismaService: /PrismaService/.test(text) }).toEqual({
        file,
        prismaService: false,
      });
      expect({ file, env: /process\.env/.test(text) }).toEqual({
        file,
        env: false,
      });
    }
  });

  it('solo el origen POS conoce PrismaService; los fixtures no tienen acceso a base de datos', () => {
    expect(FixtureTaxDocumentSource.length).toBe(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const usesPrismaService = /PrismaService/.test(text);
      const allowed = file.endsWith('pos-tax-document.source.ts');
      expect({
        file,
        usesPrismaService: usesPrismaService && !allowed,
      }).toEqual({ file, usesPrismaService: false });
    }
    const fixtureFiles = files.filter(
      (f) =>
        f.includes(join(ROOT, 'fixtures')) ||
        f.endsWith('fixture-tax-document.source.ts'),
    );
    for (const file of fixtureFiles) {
      expect(readFileSync(file, 'utf8')).not.toMatch(
        /\$queryRaw|\$transaction|PrismaService/,
      );
    }
  });

  it('ningún archivo del módulo escribe en base de datos (sin create/update/delete/upsert)', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect({
        file,
        writes:
          /(prisma|tx)\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/.test(
            text,
          ),
      }).toEqual({ file, writes: false });
    }
  });
});
