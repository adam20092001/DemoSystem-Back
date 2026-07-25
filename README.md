# DemoSystem — Backend

Backend del sistema web interno de **Punto de Venta y Gestión Comercial**.
NestJS + TypeScript + PostgreSQL + Prisma.

El contexto de trabajo del proyecto está en [CLAUDE.md](CLAUDE.md).

## Requisitos

- Node.js 20 o superior
- Docker y Docker Compose

## Puesta en marcha

```bash
# 1. Instalar dependencias
npm install

# 2. Crear el archivo de entorno local
cp .env.example .env        # en PowerShell: Copy-Item .env.example .env

# 3. Levantar PostgreSQL
npm run db:up

# 4. Generar Prisma Client
npm run prisma:generate

# 5. Ejecutar la aplicación
npm run start:dev
```

## Endpoints

| Recurso | URL |
|---|---|
| API | http://localhost:3000/api/v1 |
| Health check | http://localhost:3000/api/v1/health |
| Swagger | http://localhost:3000/api/docs |

El health check devuelve `200` cuando PostgreSQL responde y `503` cuando no
está disponible. Swagger se publica solo si `SWAGGER_ENABLED=true`.

## Verificación

```bash
npm run lint          # ESLint
npm run build         # Compilación
npm test              # Pruebas unitarias
npm run test:e2e      # Pruebas e2e (requieren el contenedor levantado)
```

## Base de datos

```bash
npm run db:up         # Levantar PostgreSQL
npm run db:down       # Detener PostgreSQL
npm run db:logs       # Ver logs del contenedor
```

Todavía no existen migraciones: el esquema de dominio se crea en la Fase 1.

## Variables de entorno

Todas se validan al arrancar; la aplicación no inicia si alguna falta o es
inválida. Ver [.env.example](.env.example) para la lista completa.
