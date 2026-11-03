export function legacyHandler(request: Request): Response {
  return Response.json({ path: new URL(request.url).pathname });
}
