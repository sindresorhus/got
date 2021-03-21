import * as https from 'https';
import * as Benchmark from 'benchmark';
import Options from '../source/core/options';
import asPromise from '../source/as-promise';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// @ts-expect-error
https.globalAgent.keepAlive = true;

const options = new Options({
	url: 'https://127.0.0.1:8080'
});

const internalSuite = new Benchmark.Suite();
internalSuite.add('got', {
	defer: true,
	fn: async (deferred: Benchmark.Deferred) => {
		await asPromise(options);
		deferred.resolve();
	}
}).on('cycle', (event: Benchmark.Event) => {
	console.log(String(event.target));
});

internalSuite.run();
