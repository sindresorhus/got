[> Back to homepage](../readme.md#documentation)

## Diagnostics Channel

Got integrates with Node.js [diagnostic channels](https://nodejs.org/api/diagnostics_channel.html) for low-overhead observability. Events are only published when subscribers exist.

### Channels

#### `got:request:create`

Emitted when a request is created.

```ts
{requestId: string, url: string, method: string}
```

#### `got:request:start`

Emitted before the native HTTP request is sent.

```ts
{requestId: string, url: string, method: string, headers: Record<string, string | string[] | undefined>}
```

#### `got:response:start`

Emitted when response headers are received.

```ts
{requestId: string, url: string, statusCode: number, headers: Record<string, string | string[] | undefined>, isFromCache: boolean}
```

#### `got:response:end`

Emitted when the response completes.

```ts
{requestId: string, url: string, statusCode: number, bodySize?: number, timings?: Timings}
```

#### `got:request:retry`

Emitted when retrying a request.

```ts
{requestId: string, retryCount: number, error: RequestError, delay: number}
```

#### `got:request:error`

Emitted when a request fails.

```ts
{requestId: string, url: string, error: RequestError, timings?: Timings}
```

#### `got:response:redirect`

Emitted when following a redirect.

```ts
{requestId: string, fromUrl: string, toUrl: string, statusCode: number}
```

### Example

```js
import diagnosticsChannel from 'node:diagnostics_channel';

const channel = diagnosticsChannel.channel('got:request:start');

channel.subscribe(message => {
	console.log(`${message.method} ${message.url}`);
});
```

All events for a single request share the same `requestId`.

### TypeScript

All message types are exported from the main package:

```ts
import type {
	DiagnosticRequestCreate,
	DiagnosticRequestStart,
	DiagnosticResponseStart,
	DiagnosticResponseEnd,
	DiagnosticRequestRetry,
	DiagnosticRequestError,
	DiagnosticResponseRedirect,
} from 'got';
```
