/** Input de CustomersService.setCreditEnabled() (NR-02A, exclusivo de ADMIN). */
export interface SetCustomerCreditInput {
  customerId: string;
  creditEnabled: boolean;
  actorUserId: string;
  ipAddress?: string | null;
}
