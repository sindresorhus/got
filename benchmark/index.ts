import * as https from 'https';
import * as Benchmark from 'benchmark';
import Request from '../source/core';
import Options from '../source/core/options';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// @ts-expect-error
https.globalAgent.keepAlive = true;

const options = new Options({
	url: 'https://127.0.0.1:8080'
});

const internalSuite = new Benchmark.Suite();
internalSuite.add('got', {
	defer: true,
	fn: (deferred: Benchmark.Deferred) => {
		const request = new Request(undefined, options);
		request.resume();
		request.once('end', () => {
			deferred.resolve();
		});
	}
}).on('cycle', (event: Benchmark.Event) => {
	console.log(String(event.target));
});

internalSuite.run();
