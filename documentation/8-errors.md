[> Back to homepage](../readme.md#documentation)

## Errors

Source code:
- [`source/core/errors.ts`](source/core/errors.ts)
- [`source/as-promise/types.ts`](source/as-promise/types.ts)
- [`source/core/response.ts`](source/core/response.ts)

All Got errors contain various metadata, such as:

- `code` - a string like `ERR_NON_2XX_3XX_RESPONSE`,
- `options` - an instance of [`Options`](`2-options.md`),
- `request` - an instance of Got Stream,
- `response` (optional) - an instance of Got Response,
- `timings` (optional) - points to `response.timings`.

**Note:**
> - The `error.stack` property may look incomplete due the execution in async function that is trigerred by a timer.
> - See https://stackoverflow.com/questions/54914770/is-there-a-good-way-to-surface-error-traces-in-production-across-event-emitters

**Note:**
> - The error codes may differ when the root error has a `code` property set.

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

When the server response code is not 2xx nor 3xx if [`options.followRedirect`](2-options.md#followredirect) is `true`, but always except for 304. Includes a `response` property.

### `MaxRedirectsError`

**Code: `ERR_TOO_MANY_REDIRECTS`**

When the server redirects you more than ten times. Includes a `response` property.

### `UnsupportedProtocolError`

**Note:**
> - This error is not public.

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
