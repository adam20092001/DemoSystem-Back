import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { ErrorResponseDto } from '../dto/error-response.dto';

/** Resultado intermedio antes de construir la respuesta final. */
interface ResolvedError {
  statusCode: number;
  message: string | string[];
  error: string;
}

/** Cuerpo que NestJS adjunta a sus HttpException estándar. */
interface HttpExceptionBody {
  message?: string | string[];
  error?: string;
}

/** A partir de este código el fallo se considera no controlado y se registra. */
const SERVER_ERROR_THRESHOLD: number = HttpStatus.INTERNAL_SERVER_ERROR;

const HTTP_ERROR_LABELS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/**
 * Filtro global de excepciones.
 *
 * Unifica el formato de error de toda la API y evita que detalles internos
 * (stack traces, mensajes del motor de base de datos) lleguen al cliente.
 * Las respuestas exitosas no se tocan: no se envuelven en ningún objeto `data`.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const resolved = this.resolve(exception);

    // Solo se registran los fallos no controlados; el detalle nunca se envía.
    if (resolved.statusCode >= SERVER_ERROR_THRESHOLD) {
      this.logger.error(
        `${request.method} ${request.url} -> ${resolved.statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorResponseDto = {
      statusCode: resolved.statusCode,
      message: resolved.message,
      error: resolved.error,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(resolved.statusCode).json(body);
  }

  private resolve(exception: unknown): ResolvedError {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = this.fromPrismaError(exception);
      if (mapped !== null) {
        return mapped;
      }
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Error interno del servidor',
      error: label(HttpStatus.INTERNAL_SERVER_ERROR),
    };
  }

  private fromHttpException(exception: HttpException): ResolvedError {
    const statusCode = exception.getStatus();
    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return { statusCode, message: payload, error: label(statusCode) };
    }

    const body = payload as HttpExceptionBody;
    return {
      statusCode,
      message: body.message ?? exception.message,
      error: body.error ?? label(statusCode),
    };
  }

  /**
   * Traduce los errores conocidos de Prisma. Se devuelve `null` para el resto,
   * que se tratan como 500 sin filtrar información del motor.
   */
  private fromPrismaError(
    exception: Prisma.PrismaClientKnownRequestError,
  ): ResolvedError | null {
    switch (exception.code) {
      case 'P2002':
        return {
          statusCode: HttpStatus.CONFLICT,
          message: 'El registro ya existe o viola una restricción de unicidad',
          error: label(HttpStatus.CONFLICT),
        };
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'El registro solicitado no existe',
          error: label(HttpStatus.NOT_FOUND),
        };
      default:
        return null;
    }
  }
}

function label(statusCode: number): string {
  return HTTP_ERROR_LABELS[statusCode] ?? 'Error';
}
