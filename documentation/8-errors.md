[> Back to homepage](../readme.md#documentation)

## Errors

Source code:
- [`source/core/errors.ts`](../source/core/errors.ts)
- [`source/as-promise/types.ts`](../source/as-promise/types.ts)
- [`source/core/response.ts`](../source/core/response.ts)

All Got errors contain various metadata, such as:

- `code` - A string like `ERR_NON_2XX_3XX_RESPONSE`,
- `options` - An instance of [`Options`](2-options.md),
- `request` - An instance of Got Stream,
- `response` (optional) - An instance of Got Response,
- `timings` (optional) - Points to `response.timings`.

#### Capturing async stack traces

Read the article [here](async-stack-traces.md).

> [!NOTE]
> - The error codes may differ when the root error has a `code` property set.
> - The root error will be propagated as is via the [`cause`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/cause) property.

### `RequestError`

**Code: `ERR_GOT_REQUEST_ERROR`**

When a request fails. Contains a `code` property with error class code, like `ECONNREFUSED`. All the errors below inherit this one.

### `CacheError`

**Code: `ERR_CACHE_ACCESS`**

When a cache method fails, for example, if the database goes down or there's a filesystem error.

### `ReadError`

**Code: `ERR_READING_RESPONSE_STREAM`**

When reading from response stream fails.

### `ParseError`

**Code: `ERR_BODY_PARSE_FAILURE`**

When server response code is 2xx, and parsing body fails. Includes a `response` property.

### `UploadError`

**Code: `ERR_UPLOAD`**

When the request body is a stream and an error occurs while reading from that stream.

### `HTTPError`

**Code: `ERR_NON_2XX_3XX_RESPONSE`**

When the request is unsuccessful.

A request is successful when the status code of the final request is `2xx` or `3xx`.

When [following redirects](2-options.md#followredirect), a request is successful **only** when the status code of the final request is `2xx`.

> [!NOTE]
> `304` responses are always considered successful.

### `MaxRedirectsError`

**Code: `ERR_TOO_MANY_REDIRECTS`**

When the server redirects you more than ten times. Includes a `response` property.

### `UnsupportedProtocolError`

> [!NOTE]
> This error is not public.

**Code: `ERR_UNSUPPORTED_PROTOCOL`**

When given an unsupported protocol.

### `TimeoutError`

**Code: `ETIMEDOUT`**

When the request is aborted due to a [timeout](6-timeout.md). Includes an `event` (a string) property along with `timings`.

### `CancelError`

**Code: `ERR_CANCELED`**

When the request is aborted with `promise.cancel()`.

### `RetryError`

**Code: `ERR_RETRYING`**

Always triggers a new retry when thrown.

### `AbortError`

**Code: `ERR_ABORTED`**

When the request is aborted with [AbortController.abort()](https://developer.mozilla.org/en-US/docs/Web/API/AbortController/abort).
