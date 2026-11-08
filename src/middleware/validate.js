export function validate(schema, source = "body") {
  return function validationMiddleware(request, _response, next) {
    const parsed = schema.safeParse(request[source]);
    if (!parsed.success) {
      next(parsed.error);
      return;
    }

    request.validated ??= {};
    request.validated[source] = parsed.data;
    next();
  };
}
