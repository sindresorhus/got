[> Back to homepage](../readme.md#documentation)

## Retry API

**Note:**
> If you're looking for retry implementation using streams, check out the [Retry Stream API](3-streams.md#retry).

**Tip:**
> You can trigger a retry by throwing the [`RetryError`](8-errors.md#retryerror) in any hook.

**Tip:**
> The `afterResponse` hook exposes a dedicated function to retry with merged options. [Read more](hooks.md#afterresponse).

### `retry`

**Type: `object`**\
**Default:**

```js
{
	limit: 2,
	methods: [
		'GET',
		'PUT',
		'HEAD',
		'DELETE',
		'OPTIONS',
		'TRACE'
	],
	statusCodes: [
		408,
		413,
		429,
		500,
		502,
		503,
		504,
		521,
		522,
		524
	],
	errorCodes: [
		'ETIMEDOUT',
		'ECONNRESET',
		'EADDRINUSE',
		'ECONNREFUSED',
		'EPIPE',
		'ENOTFOUND',
		'ENETUNREACH',
		'EAI_AGAIN'
	],
	maxRetryAfter: undefined,
	calculateDelay: ({computedValue}) => computedValue,
	backoffLimit: Number.POSITIVE_INFINITY,
	noise: 100
}
```

This option represents the `retry` object.

#### `limit`

**Type: `number`**

The maximum retry count.

#### `methods`

**Type: `string[]`**

The allowed methods to retry on.

**Note:**
> - By default, Got does not retry on `POST`.

#### `statusCodes`

**Type: `number[]`**

**Note:**
> - Only [**unsuccessful**](8-errors.md#) requests are retried. In order to retry successful requests, use an [`afterResponse`](9-hooks.md#afterresponse) hook.

The allowed [HTTP status codes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status) to retry on.

#### `errorCodes`

**Type: `string[]`**

The allowed error codes to retry on.

- `ETIMEDOUT` - One of the [timeout limits](6-timeout.md) was reached.
- `ECONNRESET`- The connection was forcibly closed.
- `EADDRINUSE`- Could not bind to any free port.
- `ECONNREFUSED`- The connection was refused by the server.
- `EPIPE` - The remote side of the stream being written has been closed.
- `ENOTFOUND` - Could not resolve the hostname to an IP address.
- `ENETUNREACH` - No internet connection.
- `EAI_AGAIN` - DNS lookup timed out.

#### `maxRetryAfter`

**Type: `number | undefined`**\
**Default: `options.timeout.request`**

The upper limit of [`retry-after` header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After). If `undefined`, it will use `options.timeout` as the value.

If the limit is exceeded, the request is canceled.

#### `calculateDelay`

**Type: `Function`**

```ts
(retryObject: RetryObject) => Promisable<number>
```

```ts
interface RetryObject {
	attemptCount: number;
	retryOptions: RetryOptions;
	error: RequestError;
	computedValue: number;
	retryAfter?: number;
}
```

The function used to calculate the delay before the next request is made. Returning `0` cancels the retry.

**Note:**
> - This function is responsible for the entire retry mechanism, including the `limit` property. To support this, you need to check if `computedValue` is different than `0`.

**Tip:**
> - This is especially useful when you want to scale down the computed value.

```js
import got from 'got';

await got('https://httpbin.org/anything', {
	retry: {
		calculateDelay: ({computedValue}) => {
			return computedValue / 10;
		}
	}
});
```

#### `backoffLimit`

**Type: `number`**

The upper limit of the `computedValue`.

By default, the `computedValue` is calculated in the following way:

```ts
((2 ** (attemptCount - 1)) * 1000) + noise
```

The delay increases exponentially.\
In order to prevent this, you can set this value to a fixed value, such as `1000`.

#### `noise`

**Type: `number`**

The maximum acceptable retry noise in the range of `-100` to `+100`.
