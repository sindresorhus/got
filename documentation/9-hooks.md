[> Back to homepage](../readme.md#documentation)

## Hooks API

### `hooks`

**Type: `object<string, Function[]>`**

This option represents the hooks to run. Thrown errors will be automatically converted to [`RequestError`](8-errors.md#requesterror).

#### `init`

**Type: `InitHook[]`**\
**Default: `[]`**

```ts
(plainRequestOptions: OptionsInit, options: Options) => void
```

Called with the plain request options, right before their normalization.\
The second argument represents the current [`Options`](2-options.md) instance.

**Note:**
> - This hook must be synchronous.

**Note:**
> - This is called every time options are merged.

**Note:**
> - The `options` object may not have the `url` property. To modify it, use a `beforeRequest` hook instead.

**Note:**
> - This hook is called when a new instance of `Options` is created.
> - Do not confuse this with the creation of `Request` or `got(…)`.

**Note:**
> - When using `got(url)` or `got(url, undefined, defaults)` this hook will **not** be called.

This is especially useful in conjunction with `got.extend()` when the input needs custom handling.

For example, this can be used to fix typos to migrate from older versions faster.

```js
import got from 'got';

const instance = got.extend({
	hooks: {
		init: [
			plain => {
				if ('followRedirects' in plain) {
					plain.followRedirect = plain.followRedirects;
					delete plain.followRedirects;
				}
			}
		]
	}
});

// Normally, the following would throw:
const response = await instance(
	'https://example.com',
	{
		followRedirects: true
	}
);

// There is no option named `followRedirects`, but we correct it in an `init` hook.
```

Or you can create your own option and store it in a context:

```js
import got from 'got';

const instance = got.extend({
	hooks: {
		init: [
			(plain, options) => {
				if ('secret' in plain) {
					options.context.secret = plain.secret;
					delete plain.secret;
				}
			}
		],
		beforeRequest: [
			options => {
				options.headers.secret = options.context.secret;
			}
		]
	}
});

const {headers} = await instance(
	'https://httpbin.org/anything',
	{
		secret: 'passphrase'
	}
).json();

console.log(headers.Secret);
//=> 'passphrase'
```

#### `beforeRequest`

**Type: `BeforeRequestHook[]`**\
**Default: `[]`**

```ts
(options: Options, context: BeforeRequestHookContext) => Promisable<void | Response | ResponseLike>
```

Called right before making the request with `options.createNativeRequestOptions()`.\
This hook is especially useful in conjunction with `got.extend()` when you want to sign your request.

The second parameter is a context object with the following properties:
- `retryCount` - The current retry count (0 for the initial request, 1+ for retries).

**Note:**
> - Got will make no further changes to the request before it is sent.

**Note:**
> - Changing `options.json` or `options.form` has no effect on the request. You should change `options.body` instead. If needed, update the `options.headers` accordingly.

```js
import got from 'got';

const response = await got.post(
	'https://httpbin.org/anything',
	{
		json: {payload: 'old'},
		hooks: {
			beforeRequest: [
				(options, context) => {
					options.body = JSON.stringify({payload: 'new'});
					options.headers['content-length'] = Buffer.byteLength(options.body).toString();
				}
			]
		}
	}
);
```

You can use `context.retryCount` to conditionally modify behavior based on whether it's the initial request or a retry:

```js
import got from 'got';

const response = await got('https://httpbin.org/status/500', {
	retry: {
		limit: 2
	},
	hooks: {
		beforeRequest: [
			(options, context) => {
				// Only log on initial request, not on retries
				if (context.retryCount === 0) {
					console.log('Making initial request');
				}
			}
		]
	}
});
```

**Tip:**
> - You can indirectly override the `request` function by early returning a [`ClientRequest`-like](https://nodejs.org/api/http.html#http_class_http_clientrequest) instance or a [`IncomingMessage`-like](https://nodejs.org/api/http.html#http_class_http_incomingmessage) instance. This is very useful when creating a custom cache mechanism.
> - [Read more about this tip](cache.md#advanced-caching-mechanisms).

#### `beforeRedirect`

**Type: `BeforeRedirectHook[]`**\
**Default: `[]`**

```ts
(updatedOptions: Options, plainResponse: PlainResponse) => Promisable<void>
```

The equivalent of `beforeRequest` but when redirecting.

**Tip:**
> - This is especially useful when you want to avoid dead sites.

```js
import got from 'got';

const response = await got('https://example.com', {
	hooks: {
		beforeRedirect: [
			(options, response) => {
				if (options.hostname === 'deadSite') {
					options.hostname = 'fallbackSite';
				}
			}
		]
	}
});
```

#### `beforeRetry`

**Type: `BeforeRetryHook[]`**\
**Default: `[]`**

```ts
(error: RequestError, retryCount: number) => Promisable<void>
```

The equivalent of `beforeError` but when retrying. Additionally, there is a second argument `retryCount`, the current retry number.

**Note:**
> - When using the Stream API, this hook is ignored.

**Note:**
> - When retrying, the `beforeRequest` hook is called afterwards.

**Note:**
> - If no retry occurs, the `beforeError` hook is called instead.

This hook is especially useful when you want to retrieve the cause of a retry.

```js
import got from 'got';

await got('https://httpbin.org/status/500', {
	hooks: {
		beforeRetry: [
			(error, retryCount) => {
				console.log(`Retrying [${retryCount}]: ${error.code}`);
				// Retrying [1]: ERR_NON_2XX_3XX_RESPONSE
			}
		]
	}
});
```

#### `beforeCache`

**Type: `BeforeCacheHook[]`**\
**Default: `[]`**

```ts
(response: PlainResponse) => false | void
```

Called right before the response is cached. Allows you to control caching behavior by modifying response properties or preventing caching entirely.

This is especially useful when you want to prevent caching of specific responses or modify cache headers.

**Return value:**
> - `false` - Prevent caching (remaining hooks are skipped)
> - `void`/`undefined` - Use default caching behavior (mutations take effect)

**Modifying the response:**
> - Hooks can directly mutate response properties like `headers`, `statusCode`, and `statusMessage`
> - Mutations to `response.headers` affect how the caching layer decides whether to cache the response and for how long
> - Changes are applied to what gets cached, not to the response the user receives (they are separate objects)

**Note:**
> - This hook is only called when the `cache` option is enabled.

**Note:**
> - This hook must be synchronous. It cannot return a Promise. If you need async logic to determine caching behavior, use a `beforeRequest` hook instead.

**Note:**
> - When returning `false`, remaining hooks are skipped. The response headers the user receives are NOT modified - only the caching layer sees modified headers.

**Note:**
> - If a hook throws an error, it will be propagated and the request will fail. This is consistent with how other hooks in Got handle errors.

**Note:**
> - At this stage, the response body has not been read yet - it's still a stream. Properties like `response.body` and `response.rawBody` are not available. You can only inspect/modify response headers and status code.

```js
import got from 'got';

// Simple: Don't cache errors
const instance = got.extend({
	cache: new Map(),
	hooks: {
		beforeCache: [
			(response) => response.statusCode >= 400 ? false : undefined
		]
	}
});

await instance('https://example.com');
```

```js
import got from 'got';

// Advanced: Modify headers for fine control
const instance2 = got.extend({
	cache: new Map(),
	hooks: {
		beforeCache: [
			(response) => {
				// Force caching with explicit duration
				// Mutations work directly - no need to return
				response.headers['cache-control'] = 'public, max-age=3600';
			}
		]
	}
});
```

#### `afterResponse`

**Type: `AfterResponseHook[]`**\
**Default: `[]`**

```ts
(response: Response, retryWithMergedOptions: (options: OptionsInit) => never) => Promisable<Response | CancelableRequest<Response>>
```

Each function should return the response. This is especially useful when you want to refresh an access token.

**Note:**
> - When using the Stream API, this hook is ignored.

**Note:**
> - Calling the `retryWithMergedOptions` function will trigger `beforeRetry` hooks. By default, remaining `afterResponse` hooks are removed to prevent duplicate execution. To preserve remaining hooks on retry, set `preserveHooks: true` in the options passed to `retryWithMergedOptions`. In case of an error, `beforeRetry` hooks will be called instead.
Meanwhile the `init`, `beforeRequest` , `beforeRedirect` as well as already executed `afterResponse` hooks will be skipped.

**Note:**
> - To preserve remaining `afterResponse` hooks after calling `retryWithMergedOptions`, set `preserveHooks: true` in the options passed to `retryWithMergedOptions`. This is useful when you want hooks to run on retried requests.

**Warning:**
> - Be cautious when using `preserveHooks: true`. If a hook unconditionally calls `retryWithMergedOptions` with `preserveHooks: true`, it will create an infinite retry loop. Always ensure hooks have proper conditional logic to avoid infinite retries.

```js
import got from 'got';

const instance = got.extend({
	hooks: {
		afterResponse: [
			(response, retryWithMergedOptions) => {
				// Unauthorized
				if (response.statusCode === 401) {
					// Refresh the access token
					const updatedOptions = {
						headers: {
							token: getNewToken()
						}
					};

					// Update the defaults
					instance.defaults.options.merge(updatedOptions);

					// Make a new retry
					return retryWithMergedOptions(updatedOptions);
				}

				// No changes otherwise
				return response;
			}
		],
		beforeRetry: [
			error => {
				// This will be called on `retryWithMergedOptions(...)`
			}
		]
	},
	mutableDefaults: true
});
```

**Example with `preserveHooks`:**

```js
import got from 'got';

const instance = got.extend({
	hooks: {
		afterResponse: [
			(response, retryWithMergedOptions) => {
				if (response.statusCode === 401) {
					return retryWithMergedOptions({
						headers: {
							authorization: getNewToken()
						},
						preserveHooks: true  // Keep remaining hooks
					});
				}

				return response;
			},
			(response) => {
				// This hook will run on the retried request
				// (the original request is interrupted when the first hook triggers a retry)
				console.log('Response received:', response.statusCode);
				return response;
			}
		]
	}
});
```

#### `beforeError`

**Type: `BeforeErrorHook[]`**\
**Default: `[]`**

```ts
(error: RequestError) => Promisable<Error>
```

Called with a [`RequestError`](8-errors.md#requesterror) instance. The error is passed to the hook right before it's thrown.

This hook can return any `Error` instance, allowing you to:
- Return custom error classes for better error handling in your application
- Extend `RequestError` with additional properties
- Return plain `Error` instances when you don't need Got-specific error information

This is especially useful when you want to have more detailed errors or maintain backward compatibility with existing error handling code.

```js
import got from 'got';

// Modify and return the error
await got('https://api.github.com/repos/sindresorhus/got/commits', {
	responseType: 'json',
	hooks: {
		beforeError: [
			error => {
				const {response} = error;
				if (response && response.body) {
					error.name = 'GitHubError';
					error.message = `${response.body.message} (${response.statusCode})`;
				}

				return error;
			}
		]
	}
});

// Return a custom error class
class CustomAPIError extends Error {
	constructor(message, statusCode) {
		super(message);
		this.name = 'CustomAPIError';
		this.statusCode = statusCode;
	}
}

await got('https://api.example.com/endpoint', {
	hooks: {
		beforeError: [
			error => {
				// Return a custom error for backward compatibility with your application
				return new CustomAPIError(
					error.message,
					error.response?.statusCode
				);
			}
		]
	}
});
```
