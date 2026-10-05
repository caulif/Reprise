const DELIVERY = Symbol('agent-tool-delivery');
type DeliveryTagged = { [DELIVERY]?: object };

export function toolDeliveryToken(result: object): object | undefined {
  return (result as DeliveryTagged)[DELIVERY];
}

export function withToolDelivery<T extends object>(result: T): T {
  return Object.assign(result, { [DELIVERY]: {} });
}

export function preserveToolDelivery<T extends object>(source: object, result: T): T {
  const token = toolDeliveryToken(source);
  return token === undefined ? result : Object.assign(result, { [DELIVERY]: token });
}
