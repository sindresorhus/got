const Request = require('./dist/core/index').default;
const Options = require('./dist/core/options').default;

const defaults = new Options({
	headers: {
		foo: 'bar'
	},
	http2: true
});

const extended = new Options(undefined, {
	headers: {
		bar: 'foo'
	}
}, defaults);

const stream = new Request('https://httpbin.org/anything', undefined, extended);

stream.destroy(new Error('oh no'));

console.log(stream.options);

// console.log(JSON.parse(JSON.stringify(stream.options)));

stream.setEncoding('utf8');
stream.on('data', console.log);
