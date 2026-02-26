# Notes

## Testing

Never use `nock` in tests. nock v14 uses `@mswjs/interceptors` under the hood and auto-activates MSW interceptors for the entire process on import — affecting all HTTP requests, even in tests that don't use nock at all. Use real local test servers via `withServer` / `withServer.exec` instead.
