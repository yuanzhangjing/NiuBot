export class DeliveryUncertainError extends Error {
  readonly requestId: string;

  constructor(requestId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeliveryUncertainError";
    this.requestId = requestId;
  }
}

export function isDeliveryUncertainError(error: unknown): error is DeliveryUncertainError {
  return error instanceof DeliveryUncertainError;
}

