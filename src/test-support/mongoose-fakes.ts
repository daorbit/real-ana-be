export type QueryStep = { method: string; args: unknown[] };

export type FakeQuery<T> = PromiseLike<T> & {
  steps: QueryStep[];
  select: (...args: unknown[]) => FakeQuery<T>;
  lean: (...args: unknown[]) => FakeQuery<T>;
  sort: (...args: unknown[]) => FakeQuery<T>;
  limit: (...args: unknown[]) => FakeQuery<T>;
  skip: (...args: unknown[]) => FakeQuery<T>;
  populate: (...args: unknown[]) => FakeQuery<T>;
  session: (...args: unknown[]) => FakeQuery<T>;
  exec: () => Promise<T>;
  catch: (onRejected: (reason: unknown) => unknown) => Promise<unknown>;
};

const CHAINABLE = ["select", "lean", "sort", "limit", "skip", "populate", "session"] as const;

export function fakeQuery<T>(result: T | (() => T | Promise<T>)): FakeQuery<T> {
  const settle = (): Promise<T> =>
    Promise.resolve().then(() => (typeof result === "function" ? (result as () => T | Promise<T>)() : result));
  const query = {
    steps: [] as QueryStep[],
    exec: settle,
    then: <A = T, B = never>(onFulfilled?: (value: T) => A | PromiseLike<A>, onRejected?: (reason: unknown) => B | PromiseLike<B>) =>
      settle().then(onFulfilled, onRejected),
    catch: (onRejected: (reason: unknown) => unknown) => settle().catch(onRejected),
  } as unknown as FakeQuery<T>;
  for (const method of CHAINABLE) {
    (query as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      query.steps.push({ method, args });
      return query;
    };
  }
  return query;
}

export function failingQuery(error: unknown): FakeQuery<never> {
  return fakeQuery<never>(() => Promise.reject(error));
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value === null || value === undefined) return undefined;
    return (value as Record<string, unknown>)[key];
  }, source);
}

export type FakeDoc<T extends Record<string, unknown>> = T & {
  get: (path: string) => unknown;
  set: (path: string, value: unknown) => void;
  save: () => Promise<FakeDoc<T>>;
  saved: number;
  toObject: () => T;
};

export function fakeDoc<T extends Record<string, unknown>>(fields: T): FakeDoc<T> {
  const doc = { ...fields } as FakeDoc<T>;
  Object.defineProperties(doc, {
    get: { value: (path: string) => readPath(doc, path), enumerable: false },
    set: {
      value: (path: string, value: unknown) => {
        (doc as Record<string, unknown>)[path] = value;
      },
      enumerable: false,
    },
    saved: { value: 0, writable: true, enumerable: false },
    save: {
      value: async () => {
        doc.saved += 1;
        return doc;
      },
      enumerable: false,
    },
    toObject: { value: () => ({ ...fields }), enumerable: false },
  });
  if (fields._id !== undefined && fields.id === undefined) {
    Object.defineProperty(doc, "id", { value: String(fields._id), enumerable: false });
  }
  return doc;
}

export function duplicateKeyError(): Error & { code: number } {
  return Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
}

export function fakeResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    locals: {} as Record<string, unknown>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}
