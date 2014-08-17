# got [![Build Status](https://travis-ci.org/sindresorhus/got.svg?branch=master)](https://travis-ci.org/sindresorhus/got)

> Simplified HTTP/HTTPS requests

A nicer interface to the built-in [`http`](http://nodejs.org/api/http.html) module.

It also supports following redirects and automagically handling gzip/deflate.

Use [request](https://github.com/mikeal/request) if you need more.


## Install

```sh
$ npm install --save got
```


## Usage

```js
var got = require('got');

// Callback mode.
got('http://todomvc.com', function (err, data, res) {
	console.log(data);
	//=> <!doctype html> ...
});

// Stream mode.
got('http://todomvc.com').pipe(fs.createWriteStream('index.html'));
```

### API

It's a `GET` request by default, but can be changed in `options`.

#### got(url, [options], [callback])

##### url

*Required*  
Type: `string`

The url to request.

##### options

Type: `object`

Any of the [`http.request`](http://nodejs.org/api/http.html#http_http_request_options_callback) options.

##### options.encoding

Type: `string`, `null`  
Default: `'utf8'`

Encoding to be used on `setEncoding` of the response data. If null, the body is returned as a Buffer.

##### callback(err, data, response)

###### data

The data you requested.

###### response

The [response object](http://nodejs.org/api/http.html#http_http_incomingmessage).


## Related

See [sent](https://github.com/floatdrop/sent) if you need to upload something.


## License

MIT © [Sindre Sorhus](http://sindresorhus.com)
