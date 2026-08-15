import { CreatePaymentDto } from './create-payment.dto';

/**
 * Mismo contrato exacto que CreatePaymentDto (method/amount/reference?): el
 * pago inicial embebido en la confirmación de una venta (directa o desde
 * cotización) nunca diverge en validación de un pago posterior — ambos
 * pasan por la misma normalización de dominio (payment-calculator.ts). Sin
 * saleId (la venta ni siquiera existe todavía en ese punto) ni actor propio
 * (el actor ya es el de la venta que lo contiene). Clase con nombre propio
 * únicamente para que el esquema OpenAPI de Sales muestre "InitialPaymentDto"
 * en vez de reutilizar ambiguamente "CreatePaymentDto" como tipo anidado.
 */
export class InitialPaymentDto extends CreatePaymentDto {}
