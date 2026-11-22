/**
 * Named values a host keeps for the session. The core declares each as an atom and reads and writes it through the
 * host's `state`, so where the values live (the engine's session state, a file, memory) is the host's business.
 */
export type StateRef = { readonly plugin: string; readonly key: string }
export type Atom<T> = { readonly ref: StateRef; readonly initial: T }
type StateHost = { state: { read: <T>(a: Atom<T>) => Promise<T>; update: <T>(a: Atom<T>, fn: (value: T) => T) => Promise<void> } }

/** A named value with its initial: read, it is never undefined. */
export const atom = <T>(ref: StateRef, initial: T): Atom<T> => Object.freeze({ ref, initial })

export const read = <T>(h: StateHost, a: Atom<T>): Promise<T> => h.state.read(a)

export const update = <T>(h: StateHost, a: Atom<T>, fn: (value: T) => T): Promise<void> => h.state.update(a, fn)
