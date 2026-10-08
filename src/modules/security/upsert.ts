const DUPLICATE_KEY = 11000;

export async function retryOnDuplicateKey<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if ((e as { code?: number }).code !== DUPLICATE_KEY) throw e;
    return run();
  }
}
