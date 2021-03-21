const Request = require('./dist/source/core/index').default;
const Options = require('./dist/source/core/options').default;
const asPromise = require('./dist/source/as-promise').default;

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

const options = new Options('https://httpbin.org/anything');

console.log(new Options(undefined, options));

(async () => {
	const response = await asPromise(options);
	console.log(response.body);
})();

/*

const stream = new Request('https://httpbin.org/anything', undefined, extended);

stream.destroy(new Error('oh no'));

console.log(stream.options);

// console.log(JSON.parse(JSON.stringify(stream.options)));

stream.setEncoding('utf8');
stream.on('data', console.log);
*/
