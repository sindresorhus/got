# got [![Build Status](https://travis-ci.org/sindresorhus/got.svg?branch=master)](https://travis-ci.org/sindresorhus/got)

> Simplified HTTP/HTTPS GET requests

Follows redirects. Not intended to be feature-rich. Use [request](https://github.com/mikeal/request) if you need something more.


## Install

```bash
$ npm install --save got
```


## Usage

```js
var got = require('got');

got('http://todomvc.com', function (err, data) {
	console.log(data);
	//=> <!doctype html> ...
});
```


## License

[MIT](http://opensource.org/licenses/MIT) © [Sindre Sorhus](http://sindresorhus.com)
