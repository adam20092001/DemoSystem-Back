export interface BlockUserInput {
  targetUserId: string;
  actorUserId: string;
  ipAddress?: string | null;
}

export type UnblockUserInput = BlockUserInput;

export type ResetPasswordInput = BlockUserInput;
