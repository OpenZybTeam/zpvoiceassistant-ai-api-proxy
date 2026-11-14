// API-key extraction.
//
// Device credentials are no longer hard-coded: the sn/secret pool lives in KV and
// is managed from /admin (see src/snpool.js). This module only pulls the bearer
// token out of the request headers.

// Pull the API key from the usual OpenAI / generic header locations.
export function extractApiKey(request) {
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return (
    request.headers.get("x-api-key") ||
    request.headers.get("api-key") ||
    ""
  );
}
