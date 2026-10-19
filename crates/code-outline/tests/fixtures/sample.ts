/** Options for the client. */
export interface ClientOptions {
  baseUrl: string;
}

type Id = string;

enum Color {
  Red,
  Green,
}

namespace Util {
  export function helper() {}
}

export class ApiClient {
  constructor(private o: ClientOptions) {}

  /** Fetch a thing. */
  get(id: Id): string {
    return id;
  }

  @log
  post(id: Id): void {}

  put(a: string): void;
  put(a: number): void;
  put(a: any): void {}
}

export const createClient = (o: ClientOptions) => new ApiClient(o);

function outer() {
  class Inner {
    run() {}
  }
}
