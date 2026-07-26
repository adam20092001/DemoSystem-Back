#!/usr/bin/env node
/**
 * Ejecuta un comando cargando variables desde el archivo .env indicado,
 * sin depender de sintaxis de shell (funciona igual en PowerShell y bash).
 * Uso: node scripts/run-with-env.js .env.test prisma migrate deploy
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { config } = require('dotenv');

const [, , envFile, command, ...args] = process.argv;

if (!envFile || !command) {
  console.error(
    'Uso: node scripts/run-with-env.js <archivo-env> <comando> [args...]',
  );
  process.exit(1);
}

const result = config({ path: path.resolve(process.cwd(), envFile) });
if (result.error) {
  console.error(`No se pudo cargar ${envFile}: ${result.error.message}`);
  process.exit(1);
}

const child = spawnSync(command, args, {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

process.exit(child.status ?? 1);
