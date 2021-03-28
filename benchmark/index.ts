import * as https from 'https';
import * as Benchmark from 'benchmark';
import Options from '../source/core/options';
import got from '../source';

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
		const promise = got(options);

		try {
			await promise;
		} catch {
			// Empty on purpose.
		} finally {
			deferred.resolve();
		}
	}
}).on('cycle', (event: Benchmark.Event) => {
	console.log(String(event.target));
});

internalSuite.run();
