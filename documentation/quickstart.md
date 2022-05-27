# Quick start guide
This quick start uses ES2017 syntax.

## Getting and posting data with promises
The simplest `GET` request :

```js
import got from "got";

const response = await got("https://httpbin.org/anything");
```

The call returns a <code>Promise<[Response](3-streams.md#response-1)></code>. If the body contains json, it can be retreived directly :

```js
const data = await got("https://httpbin.org/anything").json();
```

The similar <code>[got.text](1-promise.md#promisetext)</code> method returns plain text.

All `got` methods accepts an option object for passing extra informations, such as headers :

```js
const data = await got("https://httpbin.org/anything", {
	headers: {
		"Custom-Header": "Quick start",
	},
  timeout: { send: 3500 }
}).json();
```

A `POST` request is very similar :
```js
const data = await got.post("https://httpbin.org/anything", {
  json: { documentName: "Quick Start" }
}).json();
```
The request body is passed in the option object, `json` property will automatically set headers accordingly. Custom headers can be added exactly as above.

## Using streams
The [Stream API](3-streams.md) allows to leverage [Node.js Streams](https://nodejs.dev/learn/nodejs-streams) capabilities :
```js
import got from "got";
import fs from "fs"

got.stream.post("https://httpbin.org/anything", {
    json: { documentName: "Quick Start" },
  })
  .pipe(fs.createWriteStream("anything.json"));
```

## Options

Options can be set at client level and reused in subsequent queries :
```js
import got from "got";

const client = got.extend({
  prefixUrl: "https://httpbin.org",
	headers: {
		"Authorization": getTokenFromVault()
	},
});

export default client;
```

## Errors
Both Promise and Stream APIs throws error with metadata. They are handled according to the API used.

```js
import got from "got";

const data = await got
  .get("https://httpbin.org/status/404")
  .catch(e => console.error(e.code, e.message));
```

```js
import got from "got";

got.stream
  .get("https://httpbin.org/status/404")
  .once("error", e => console.error(e.code, e.message))
  .pipe(fs.createWriteStream("anything.json"));
```
