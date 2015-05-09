<h1 align="center">
	<br>
	<img width="360" src="https://rawgit.com/sindresorhus/got/master/media/logo.svg" alt="got">
	<br>
	<br>
	<br>
</h1>

> Simplified HTTP/HTTPS requests

[![Build Status](https://travis-ci.org/sindresorhus/got.svg?branch=master)](https://travis-ci.org/sindresorhus/got)

A nicer interface to the built-in [`http`](http://nodejs.org/api/http.html) module.

It supports following redirects, streams, automagically handling gzip/deflate and some convenience options.

Created because [`request`](https://github.com/mikeal/request) is bloated *(several megabytes!)* and slow.


## Install

```
$ npm install --save got
```


## Usage

```js
var got = require('got');

// Callback mode
got('todomvc.com', function (err, data, res) {
	console.log(data);
	//=> <!doctype html> ...
});


// Stream mode
got('todomvc.com').pipe(fs.createWriteStream('index.html'));

// For POST, PUT and PATCH methods got returns a WritableStream
fs.createReadStream('index.html').pipe(got.post('todomvc.com'));
```

### API

It's a `GET` request by default, but can be changed in `options`.

#### got(url, [options], [callback])

##### url

*Required*  
Type: `string`, `Object`

The URL to request or bare [http.request options](https://nodejs.org/api/http.html#http_http_request_options_callback) object.

##### options

Type: `object`

Any of the [`http.request`](http://nodejs.org/api/http.html#http_http_request_options_callback) options.

###### body

Type: `string`, `Buffer`, `ReadableStream`  

_This option and stream mode are mutually exclusive._

Body, that will be sent with `POST` request. If present in `options` and `options.method` is not set - `options.method` will be set to `POST`.

###### encoding

Type: `string`, `null`  
Default: `'utf8'`

Encoding to be used on `setEncoding` of the response data. If null, the body is returned as a Buffer.

###### json

Type: `Boolean`  
Default: `false`

_This option and stream mode are mutually exclusive._

If enabled, response body will be parsed with `JSON.parse` and `accept` header will be set to `application/json` by default.

###### query

Type: `string`, `Object`  

Query string object, that will be added to request url. This will override query string in `url`.

###### timeout

Type: `number`

Milliseconds after which the request will be aborted and an error event with `ETIMEDOUT` code will be emitted.

###### agent

[http.Agent](http://nodejs.org/api/http.html#http_class_http_agent) instance.

If `undefined` - [`infinity-agent`](https://github.com/floatdrop/infinity-agent) will be used to backport Agent class from Node core.

To use default [globalAgent](http://nodejs.org/api/http.html#http_http_globalagent) just pass `null` to this option.

##### callback(err, data, response)

###### err

`Error` object with HTTP status code as `code` property.

###### data

The data you requested.

###### response

The [response object](http://nodejs.org/api/http.html#http_http_incomingmessage).

When in stream mode, you can listen for events:

##### .on('response', response)

`response` event to get the response object.

##### .on('redirect', response, nextOptions)

`redirect` event to get the response object of redirect. Second argument is options for next request to the redirect location.


###### response

The [response object](http://nodejs.org/api/http.html#http_http_incomingmessage).

#### got.get(url, [options], [callback])
#### got.post(url, [options], [callback])
#### got.put(url, [options], [callback])
#### got.patch(url, [options], [callback])
#### got.head(url, [options], [callback])
#### got.delete(url, [options], [callback])

Sets `options.method` to the method name and makes a request.


## Proxy

You can use the [`tunnel`](https://github.com/koichik/node-tunnel) module with the `agent` option to work with proxies:

```js
var got = require('got');
var tunnel = require('tunnel');

got('todomvc.com', {
	agent: tunnel.httpOverHttp({
		proxy: {
			host: 'localhost'
		}
	})
}, function () {});
```


## Tip

It's a good idea to set the `'user-agent'` header so the provider can more easily see how their resource is used. By default it's the URL to this repo.

```js
var got = require('got');

got('todomvc.com', {
	headers: {
		'user-agent': 'https://github.com/your-username/repo-name'
	}
}, function () {});
```


## Related

 * [`gh-got`](https://github.com/sindresorhus/gh-got) - Convenience wrapper for interacting with the GitHub API
 * [`got-promise`](https://github.com/floatdrop/got-promise) - Promise wrapper
 * [`co-got`](https://github.com/dotcypress/co-got) - Co-like interface wrapper


## License

MIT © [Sindre Sorhus](http://sindresorhus.com)
