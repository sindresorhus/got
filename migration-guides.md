# Migration guides

> :star: Switching from other HTTP request libraries to Got :star:

### Migrating from Request

First of all, we need to know the differences.

#### Unchanged things

These options remain unchanged:

- `baseUrl`
- `method`
- `headers`
- `json`
- `auth`
- `followRedirect`
- `agent`
- `localAddress`
- `timeout`
- `encoding`

So if you're familiar with them, you're good to go :)

#### Renamed options

- `qs` → `query`
- `strictSSL` → `rejectUnauthorized`
- `gzip` → `decompress`

#### Changes in behavior

The `timeout` option works in the same way if you provide a number. But here's the thing: you can set timeouts on particular events! [Click here](readme.md#timeout) to read more.

The `query` option is serialized using [`URLSearchParams`](https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams).

The `gzip` option is called `decompress`. Decompressing affects the response object: the stream will send decompressed data.

There's no `time` option. Imagine it's always set to `true`. You can access the timings through `response.timings`.

Streams work the same, but you need to use `got.stream(url, options)`.

#### Breaking changes

In Got, `url` is not an option. It's an argument:

```js
await got(url, options)
```

There's no `jsonReviver` nor `jsonReviver` option.

Got supports forms, but there's no `form` option. You have to pass a [`form-data` instance](https://github.com/form-data/form-data) through the `body` option.

There's no `oauth`/`hawk`/`aws`/`httpSignature` option. To sign requests, you need to create a [custom instance](advanced-creation.md#signing-requests).

There's no `followAllRedirects` option. [More info.](readme.md#followredirect)

There are no `agentClass`/`agentOptions`/`forever`/`pool` options.

There are no proxy options. You need to [pass custom agent](https://github.com/sindresorhus/got#proxies).

*need to write something about `removeRefererHeader`*

*TODO: cookies*
