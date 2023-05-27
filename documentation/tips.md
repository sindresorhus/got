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

Got supports cookies out of box. There is no need to parse them manually.\
In order to use cookies, pass a `CookieJar` instance from the [`tough-cookie`](https://github.com/salesforce/tough-cookie) package.

```js
import got from 'got';
import {CookieJar} from 'tough-cookie';

const cookieJar = new CookieJar();

await cookieJar.setCookie('foo=bar', 'https://httpbin.org');
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

See the [`enableUnixSockets` option](./2-options.md#enableunixsockets).

### Testing

Got uses the native [`http`](https://nodejs.org/api/http.html) module, which depends on the native [`net`](https://nodejs.org/api/net.html) module.\
This means there are two possible ways to test:

1. Use a mocking library like [`nock`](https://github.com/nock/nock),
2. Create a server.

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

**Note:**
> - The popular [`tunnel`](https://www.npmjs.com/package/tunnel) package is unmaintained. Use at your own risk.
> - The [`proxy-agent`](https://www.npmjs.com/package/proxy-agent) family doesn't follow newest Node.js features and lacks support.

Although there isn't a perfect, bug-free package, [Apify](https://apify.com/)'s solution is a modern one.\
See [`got-scraping/src/agent/h1-proxy-agent.ts`](https://github.com/apify/got-scraping/blob/2ec7f9148917a6a38d6d1c8c695606767c46cce5/src/agent/h1-proxy-agent.ts). It has the same API as `hpagent`.

[`hpagent`](https://github.com/delvedor/hpagent) is a modern package as well. In contrast to `tunnel`, it allows keeping the internal sockets alive to be reused.

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

### Retry without an agent

If you're using proxies, you may run into connection issues.\
One way out is to disable proxies when retrying. The solution for the Stream API looks like this:

```js
import https from 'node:https';
import fs from 'node:fs';
import got from 'got';

class MyAgent extends https.Agent {
	createConnection(port, options, callback) {
		console.log(`Connecting with MyAgent`);
		return https.Agent.prototype.createConnection.call(this, port, options, callback);
	}
}

const proxy = new MyAgent();

let writeStream;

const fn = retryStream => {
	const options = {
		agent: {
			https: proxy,
		}
	};

	const stream = retryStream ?? got.stream('https://example.com', options);

	if (writeStream) {
		writeStream.destroy();
	}

	writeStream = fs.createWriteStream('example-com.html');

	stream.pipe(writeStream);
	stream.once('retry', (retryCount, error, createRetryStream) => {
		fn(createRetryStream({
			agent: {
				http: undefined,
				https: undefined,
				http2: undefined,
			},
		}));
	});
};

fn();
```

### `h2c`

There is no direct [`h2c`](https://datatracker.ietf.org/doc/html/rfc7540#section-3.1) support.

However, you can provide a `h2session` option in a `beforeRequest` hook. See [an example](examples/h2c.js).

### Uppercase headers

Got always normalizes the headers, therefore passing an `Uppercase-Header` will transform it into `uppercase-header`. To fix this, you need to pass a wrapped agent:

```js
class WrappedAgent {
    constructor(agent) {
        this.agent = agent;
    }

    addRequest(request, options) {
        return this.agent.addRequest(request, options);
    }

    get keepAlive() {
        return this.agent.keepAlive;
    }

    get maxSockets() {
        return this.agent.maxSockets;
    }

    get options() {
        return this.agent.options;
    }

    get defaultPort() {
        return this.agent.defaultPort;
    }

    get protocol() {
        return this.agent.protocol;
    }
}

class TransformHeadersAgent extends WrappedAgent {
    addRequest(request, options) {
        const headers = request.getHeaderNames();

        for (const header of headers) {
            request.setHeader(this.transformHeader(header), request.getHeader(header));
        }

        return super.addRequest(request, options);
    }

    transformHeader(header) {
        return header.split('-').map(part => {
            return part[0].toUpperCase() + part.slice(1);
        }).join('-');
    }
}

const agent = new http.Agent({
    keepAlive: true
});

const wrappedAgent = new TransformHeadersAgent(agent);
```

See [an example](examples/uppercase-headers.js).

### Custom options

Got v12 throws when an option does not exist. Therefore passing a top-level option such as:

```js
import got from 'got';

await got('https://example.com', {
	foo: 'bar'
});
```

will throw. To prevent this, you need read the option in an `init` hook:

```js
import got from 'got';

const convertFoo = got.extend({
	hooks: {
		init: [
			(rawOptions, options) => {
				if ('foo' in rawOptions) {
					options.context.foo = rawOptions.foo;
					delete rawOptions.foo;
				}
			}
		]
	}
});

const instance = got.extend(convertFoo, {
	hooks: {
		beforeRequest: [
			options => {
				options.headers.foo = options.context.foo;
			}
		]
	}
});

const {headers} = await instance('https://httpbin.org/anything', {foo: 'bar'}).json();
console.log(headers.Foo); //=> 'bar'
```

Eventually, you may want to create a catch-all instance:

```js
import got from 'got';

const catchAllOptions = got.extend({
    hooks: {
        init: [
            (raw, options) => {
                for (const key in raw) {
                    if (!(key in options)) {
                        options.context[key] = raw[key];
                        delete raw[key];
                    }
                }
            }
        ]
    }
});

const instance = got.extend(catchAllOptions, {
	hooks: {
		beforeRequest: [
			options => {
				// All custom options will be visible under `options.context`
				options.headers.foo = options.context.foo;
			}
		]
	}
});

const {headers} = await instance('https://httpbin.org/anything', {foo: 'bar'}).json();
console.log(headers.Foo); //=> 'bar'
```

**Note:**
> - It's a good practice to perform the validation inside the `init` hook. You can safely throw when an option is unknown! Internally, Got uses the [`@sindresorhus/is`](https://github.com/sindresorhus/is) package.

### Electron `net` module is not supported

**Note:** Got v12 and later is an ESM package, but Electron does not yet support ESM. So you need to use Got v11.

Got doesn't support the `electron.net` module. It's missing crucial APIs that are available in Node.js.\
While Got used to support `electron.net`, it got very unstable and caused many errors.

However, you can use [IPC communication](https://www.electronjs.org/docs/api/ipc-main#ipcmainhandlechannel-listener) to get the Response object:

```js
// Main process
const got = require('got');

const instance = got.extend({
	// ...
});

ipcMain.handle('got', async (event, ...args) => {
	const {statusCode, headers, body} = await instance(...args);
	return {statusCode, headers, body};
});

// Renderer process
async () => {
	const {statusCode, headers, body} = await ipcRenderer.invoke('got', 'https://httpbin.org/anything');
	// ...
}
```
