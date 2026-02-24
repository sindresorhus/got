[> Back to homepage](../../readme.md#documentation)

## Migration guides

> You may think it's too hard to switch, but it's really not. 🦄

### Axios

Axios is very similar to Got. The difference is that Axios targets browsers first, while Got fully makes use of Node.js features.

#### Common options

These options remain the same as well:

- [`url`](../2-options.md#url)
- [`method`](../2-options.md#method)
- [`headers`](../2-options.md#headers)
- [`maxRedirects`](../2-options.md#maxredirects)
- [`decompress`](../2-options.md#decompress)

#### Renamed options

We deeply care about readability, so we renamed these options:

- `httpAgent` → [`agent.http`](../2-options.md#agent)
- `httpsAgent` → [`agent.https`](../2-options.md#agent)
- `socketPath` → [`url`](../2-options.md#enableunixsockets)
- `responseEncoding` → [`encoding`](../2-options.md#encoding)
- `auth.username` → [`username`](../2-options.md#username)
- `auth.password` → [`password`](../2-options.md#password)
- `data` → [`body`](../2-options.md#body) / [`json`](../2-options.md#json) / [`form`](../2-options.md#form)
- `params` → [`searchParams`](../2-options.md#searchparams)

#### Changes in behavior

- `transformRequest` → [`hooks.beforeRequest`](../9-hooks.md#beforerequest)
  - The API is different.
- `transformResponse` → [`hooks.afterResponse`](../9-hooks.md#afterresponse)
  - The API is different.
- `baseUrl` → [`prefixUrl`](../2-options.md#prefixurl)
  - The `prefixUrl` is always prepended to the `url`.
- [`timeout`](../6-timeout.md)
  - This option is now an object. You can now set timeouts on particular events!
- [`responseType`](../2-options.md#responsetype)
  - Accepts `'text'`, `'json'` or `'buffer'`.

#### Breaking changes

- `onUploadProgress`
  - This option does not exist. Instead, use [`got(…).on('uploadProgress', …)`](../3-streams.md#uploadprogress).
- `onDownloadProgress`
  - This option does not exist. Instead, use [`got(…).on('downloadProgress', …)`](../3-streams.md#downloadprogress).
- `maxContentLength`
  - This option does not exist. Instead, use [a handler](../examples/advanced-creation.js).
- `validateStatus`
  - This option does not exist. Got automatically validates the status according to [the specification](https://datatracker.ietf.org/doc/html/rfc7231#section-6).
- `proxy`
  - This option does not exist. You need to pass [an `agent`](../tips.md#proxy) instead.
- `cancelToken`
  - Use the [`signal`](../2-options.md#signal) option with [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).
- `paramsSerializer`
  - This option does not exist.
- `maxBodyLength`
  - This option does not exist.

#### Response

The response object is different as well:

- `response.data` → [`response.body`](../3-streams.md#response-1)
- `response.status` → [`response.statusCode`](../3-streams.md#response-1)
- `response.statusText` → [`response.statusMessage`](../3-streams.md#response-1)
- `response.config` → [`response.request.options`](../3-streams.md#response-1)
- [`response.request`](../3-streams.md#response-1)
  - Returns [a Got stream](../3-streams.md).

The `response.headers` object remains the same.

#### Interceptors

Got offers [hooks](../9-hooks.md) instead, which are more flexible.

#### Errors

Errors look the same, with the difference `error.request` returns a Got stream. Furthermore, Got provides [more details](../8-errors.md) to make debugging easier.

#### Abort

Got supports [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) via the [`signal`](../2-options.md#signal) option.

#### Convenience methods

Convenience methods, such as `axios.get(…)` etc. remain the same: `got.get(…)`. Instead of `axios.create(…)` use `got.extend(…)`.

#### You're good to go!

Well, you have already come this far :tada:\
Take a look at the [documentation](../../readme.md#documentation). It's worth the time to read it.\
There are [some great tips](../tips.md).

If something is unclear or doesn't work as it should, don't hesitate to [open an issue](https://github.com/sindresorhus/got/issues/new/choose).
