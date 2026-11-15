export const SANDBOX_SCRIPTS =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads; frame-ancestors 'none'";
export const SANDBOX_STATIC =
  "sandbox allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads; frame-ancestors 'none'";
export const PDF_CSP = "frame-ancestors 'none'";

/** Signed-path files may be framed by the content origin only: the artifact frame page (design 10). */
export const framedBySelf = (csp: string) => csp.replace("frame-ancestors 'none'", "frame-ancestors 'self'");

/**
 * Artifact frame page (design 10): not sandboxed, so that its origin is the content origin and the signed path it
 * frames accepts it (`frame-ancestors 'self'`); nothing active is allowed in it.
 */
export const FRAME_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
