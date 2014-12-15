# got [![Build Status](https://travis-ci.org/sindresorhus/got.svg?branch=master)](https://travis-ci.org/sindresorhus/got)

> Simplified HTTP/HTTPS requests

A nicer interface to the built-in [`http`](http://nodejs.org/api/http.html) module.

It also supports following redirects, streams, and automagically handling gzip/deflate.

Use [request](https://github.com/mikeal/request) if you need more.


## Install

```sh
$ npm install --save got
```


## Usage

```js
var got = require('got');

// Callback mode
got('http://todomvc.com', function (err, data, res) {
	console.log(data);
	//=> <!doctype html> ...
});


// Stream mode
got('http://todomvc.com').pipe(fs.createWriteStream('index.html'));

// For POST, PUT and PATCH methods got returns a WritableStream
fs.createReadStream('index.html').pipe(got.post('http://todomvc.com'));
```

### API

It's a `GET` request by default, but can be changed in `options`.

#### got(url, [options], [callback])

##### url

*Required*  
Type: `string`

The URL to request.

##### options

Type: `object`

Any of the [`http.request`](http://nodejs.org/api/http.html#http_http_request_options_callback) options.

##### options.encoding

Type: `string`, `null`  
Default: `'utf8'`

Encoding to be used on `setEncoding` of the response data. If null, the body is returned as a Buffer.

##### options.body

Type: `string`, `Buffer`  

Body, that will be sent with `POST` request. If present in `options` and `options.method` is not set - `options.method` will be set to `POST`.

This option and stream mode are mutually exclusive.

##### options.timeout

Type: `number`

Milliseconds after which the request will be aborted and an error event with `ETIMEDOUT` code will be emitted.

##### callback(err, data, response)

###### err

`Error` object with HTTP status code as `code` property.

###### data

The data you requested.

###### response

The [response object](http://nodejs.org/api/http.html#http_http_incomingmessage).

#### got.get(url, [options], [callback])
#### got.post(url, [options], [callback])
#### got.put(url, [options], [callback])
#### got.patch(url, [options], [callback])
#### got.head(url, [options], [callback])
#### got.delete(url, [options], [callback])

Sets `options.method` to the method name and makes a request.


## License

MIT © [Sindre Sorhus](http://sindresorhus.com)
