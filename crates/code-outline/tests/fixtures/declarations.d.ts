/** Table core. */
export interface Table<in out TFeatures extends Features, in out TData extends RowData> {
  /** Reactivity bindings. */
  readonly _reactivity: Bindings;
  _rowModels: RowModels<TData>;
  options?: {
    debug: boolean;
  };
  getState(): State;
  [key: string]: unknown;
}

export type Options<out T> = {
  data: T[];
  onChange(next: T[]): void;
};

export type Mapped = { [K in keyof State]: number };

export declare class Store<in T> {
  value: T;
  private _listeners;
  constructor(value: T);
  get(): T;
}

export declare function make(o: { a: { b: string } }): void;
