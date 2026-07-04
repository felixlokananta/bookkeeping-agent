export function getBindHost(): string {
  const raw = process.env.BOOKKEEPING_ALLOW_EXTERNAL_BIND?.toLowerCase();
  return raw === "true" || raw === "1" ? "0.0.0.0" : "127.0.0.1";
}

export function assertSafeBindConfig(host: string, token: string | undefined): void {
  if (host !== "127.0.0.1" && !token) {
    throw new Error(
      "Refusing to bind to a non-localhost interface without BOOKKEEPING_AUTH_TOKEN set. " +
        "Set BOOKKEEPING_AUTH_TOKEN, or unset BOOKKEEPING_ALLOW_EXTERNAL_BIND to bind to localhost only."
    );
  }
}
