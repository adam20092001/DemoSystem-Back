import { ImportOperationStatus } from '@prisma/client';

interface SafeImportOperationActor {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

/** Respuesta segura de ImportOperation (Fase B1). */
export interface SafeImportOperation {
  id: string;
  reference: string;
  description: string | null;
  originCountry: string;
  destinationCountry: string;
  status: ImportOperationStatus;
  externalReference: string | null;
  notes: string | null;
  createdBy: SafeImportOperationActor;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  completedBy: SafeImportOperationActor | null;
  cancelledAt: Date | null;
  cancelledBy: SafeImportOperationActor | null;
  cancellationReason: string | null;
  shipmentCount: number;
}
