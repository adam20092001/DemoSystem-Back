import { SafeUser } from './safe-user';

/** temporaryPassword solo se entrega en esta respuesta; nunca se persiste en claro. */
export interface ResetPasswordResult {
  user: SafeUser;
  temporaryPassword: string;
}
