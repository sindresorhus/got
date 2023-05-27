[> Back to homepage](../../readme.md#documentation)

## Migration guides

> You may think it's too hard to switch, but it's really not. 🦄

### Node.js

Let's make a simple request. With Node.js, this is:

```js
import http from 'node:http';

const request = http.request('https://httpbin.org/anything', response => {
	if (response.statusCode >= 400) {
		request.destroy(new Error());
		return;
	}

	const chunks = [];

	response.on('data', chunk => {
		chunks.push(chunk);
	});

	response.once('end', () => {
		const buffer = Buffer.concat(chunks);

		if (response.statusCode >= 400) {
			const error = new Error(`Unsuccessful response: ${response.statusCode}`);
			error.body = buffer.toString();
			return;
		}

		const text = buffer.toString();

		console.log(text);
	});

	response.once('error', console.error);
});

request.once('error', console.error);
request.end();
```

With Got, this becomes:

```js
import got from 'got';

try {
	const {body} = await got('https://httpbin.org/anything');
	console.log(body);
} catch (error) {
	console.error(error);
}
```

Much cleaner. But what about streams?

```js
import http from 'node:http';
import fs from 'node:fs';

const source = fs.createReadStream('article.txt');

const request = http.request('https://httpbin.org/anything', {
	method: 'POST'
}, response => {
	response.pipe(fs.createWriteStream('httpbin.txt'));
});

source.pipe(request);
```

Well, it's easy as that:

```js
import got from 'got';
import {pipeline as streamPipeline} from 'node:stream/promises';
import fs from 'node:fs';

await streamPipeline(
	fs.createReadStream('article.txt'),
	got.stream.post('https://httpbin.org/anything'),
	fs.createWriteStream('httpbin.txt')
);
```

The advantage is that Got also handles errors automatically, so you don't have to create custom listeners.

Furthermore, Got supports redirects, compression, advanced timeouts, cache, pagination, cookies, hooks, and more!

#### What next?

Unfortunately Got options differ too much from the Node.js options. It's not possible to provide a brief summary.\
Don't worry, you will learn them fast - they are easy to understand! Every option has an example attached.

Take a look at the [documentation](../../readme.md#documentation). It's worth the time to read it.\
There are [some great tips](../tips.md).

If something is unclear or doesn't work as it should, don't hesitate to [open an issue](https://github.com/sindresorhus/got/issues/new/choose).
