[> Back to homepage](../readme.md#documentation)

## Tips

### Timeout

Each request can have a maximum allowed time to run.\
In order to use this, specify the `request` timeout option.

```js
import got from 'got';

const body = await got('https://httpbin.org/anything', {
	timeout: {
		request: 30000
	}
});
```

For more specific timeouts, visit the [Timeout API](6-timeout.md).

### Retries

By default, Got makes a new retry on a failed request if possible.

It is possible to disable this feature entirely by setting the amount of maximum allowed retries to `0`.

```js
import got from 'got';

const noRetryGot = got.extend({
	retry: {
		limit: 0
	}
});
```

In order to specify retriable errors, use the [Retry API](7-retry.md).

### Cookies

Got supports cookies out of box. There is no need for parsing them manually.\
In order to use cookies, pass a `CookieJar` instance from the [`tough-cookie`](https://github.com/salesforce/tough-cookie) package.

```js
import {promisify} from 'util';
import got from 'got';
import {CookieJar} from 'tough-cookie';

const cookieJar = new CookieJar();
const setCookie = promisify(cookieJar.setCookie.bind(cookieJar));

await setCookie('foo=bar', 'https://httpbin.org');
await got('https://httpbin.org/anything', {cookieJar});
```

### AWS

Requests to AWS services need to have their headers signed.\
This can be accomplished by using the [`got4aws`](https://github.com/SamVerschueren/got4aws) package.

This is an example for querying an [`API Gateway`](https://docs.aws.amazon.com/apigateway/api-reference/signing-requests/) with a signed request.

```js
import got4aws from 'got4aws';

const got = got4aws();

const response = await got('https://<api-id>.execute-api.<api-region>.amazonaws.com/<stage>/endpoint/path', {
	// …
});
```

### Pagination

When working with large datasets, it's very efficient to use pagination.\
By default, Got uses the [`Link` header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Link) to retrieve the next page.\
However, this behavior can be customized, see the [Pagination API](4-pagination.md).

```js
const countLimit = 50;

const pagination = got.paginate('https://api.github.com/repos/sindresorhus/got/commits', {
	pagination: {countLimit}
});

console.log(`Printing latest ${countLimit} Got commits (newest to oldest):`);

for await (const commitData of pagination) {
	console.log(commitData.commit.message);
}
```

<a name="unix"></a>
### UNIX Domain Sockets

Requests can also be sent via [UNIX Domain Sockets](https://serverfault.com/questions/124517/what-is-the-difference-between-unix-sockets-and-tcp-ip-sockets).\
Use the following URL scheme: `PROTOCOL://unix:SOCKET:PATH`

- `PROTOCOL` - `http` or `https`
- `SOCKET` - absolute path to a unix domain socket, for example: `/var/run/docker.sock`
- `PATH` - request path, for example: `/v2/keys`

```js
import got from 'got';

await got('http://unix:/var/run/docker.sock:/containers/json');

// Or without protocol (HTTP by default)
await got('unix:/var/run/docker.sock:/containers/json');
```

### Testing

Got uses the native [`http`](https://nodejs.org/api/http.html) module, which depends on the native [`net`](https://nodejs.org/api/net.html) module.\
This means there are two possible ways to test:

1. use a mocking library like [`nock`](https://github.com/nock/nock),
2. create a server.

The first approach should cover all common use cases.\
Bear in mind that it overrides the native `http` module, so bugs may occur due to the differences.

The most solid way is to create a server.\
There may be cases where `nock` won't be sufficient or lacks functionality.

#### Nock

By default `nock` mocks only one request.\
Got will [retry](7-retry.md) on failed requests by default, causing a `No match for request ...` error.\
The solution is to either disable retrying (set `options.retry.limit` to `0`) or call `.persist()` on the mocked request.

```js
import got from 'got';
import nock from 'nock';

const scope = nock('https://sindresorhus.com')
	.get('/')
	.reply(500, 'Internal server error')
	.persist();

try {
	await got('https://sindresorhus.com')
} catch (error) {
	console.log(error.response.body);
	//=> 'Internal server error'

	console.log(error.response.retryCount);
	//=> 2
}

scope.persist(false);
```

### Proxying

You can use the [`tunnel`](https://github.com/koichik/node-tunnel) package with the `agent` option to work with proxies:

```js
import got from 'got';
import tunnel from 'tunnel';

await got('https://sindresorhus.com', {
	agent: {
		https: tunnel.httpsOverHttp({
			proxy: {
				host: 'localhost'
			}
		})
	}
});
```

Otherwise, you can use the [`hpagent`](https://github.com/delvedor/hpagent) package, which keeps the internal sockets alive to be reused.

```js
import got from 'got';
import {HttpsProxyAgent} from 'hpagent';

await got('https://sindresorhus.com', {
	agent: {
		https: new HttpsProxyAgent({
			keepAlive: true,
			keepAliveMsecs: 1000,
			maxSockets: 256,
			maxFreeSockets: 256,
			scheduling: 'lifo',
			proxy: 'https://localhost:8080'
		})
	}
});
```

Alternatively, use [`global-agent`](https://github.com/gajus/global-agent) to configure a global proxy for all HTTP/HTTPS traffic in your program.

If you're using HTTP/2, the [`http2-wrapper`](https://github.com/szmarczak/http2-wrapper/#proxy-support) package provides proxy support out-of-box.\
[Learn more.](https://github.com/szmarczak/http2-wrapper#proxy-support)
