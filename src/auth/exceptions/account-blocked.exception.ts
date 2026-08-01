import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Código estable para que el frontend distinga esta condición sin depender
 * del texto del mensaje (que puede cambiar o traducirse).
 */
export const ACCOUNT_BLOCKED_CODE = 'ACCOUNT_BLOCKED';

export const ACCOUNT_BLOCKED_MESSAGE =
  'La cuenta se encuentra bloqueada. Contacta al administrador.';

/**
 * Se lanza únicamente cuando la contraseña ya fue verificada como correcta
 * y el usuario está BLOCKED. Nunca debe lanzarse antes de validar la
 * contraseña: eso revelaría la existencia/estado de la cuenta a quien no la
 * posee.
 */
export class AccountBlockedException extends HttpException {
  constructor() {
    super(
      { message: ACCOUNT_BLOCKED_MESSAGE, code: ACCOUNT_BLOCKED_CODE },
      HttpStatus.LOCKED,
    );
  }
}
