import https from 'node:https';
/// import axios from 'axios';
import Benchmark from 'benchmark';
import fetch from 'node-fetch';
import request from 'request';
import got from '../source/index.js';
import Request from '../source/core/index.js';
import Options, {type OptionsInit} from '../source/core/options.js';

// Configuration
const httpsAgent = new https.Agent({
	keepAlive: true,
	rejectUnauthorized: false,
});

const url = new URL('https://127.0.0.1:8081');
const urlString = url.toString();

const gotOptions: OptionsInit & {isStream?: true} = {
	agent: {
		https: httpsAgent,
	},
	https: {
		rejectUnauthorized: false,
	},
	retry: {
		limit: 0,
	},
};

const normalizedGotOptions = new Options(url, gotOptions);

const requestOptions = {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	strictSSL: false,
	agent: httpsAgent,
};

const fetchOptions = {
	agent: httpsAgent,
};

/// const axiosOptions = {
// 	url: urlString,
// 	httpsAgent,
// 	https: {
// 		rejectUnauthorized: false,
// 	},
// };

// const axiosStreamOptions: typeof axiosOptions & {responseType: 'stream'} = {
// 	...axiosOptions,
// 	responseType: 'stream',
// };

const httpsOptions = {
	https: {
		rejectUnauthorized: false,
	},
	agent: httpsAgent,
};

const suite = new Benchmark.Suite();

// Benchmarking
suite.add('got - promise', {
	defer: true,
	async fn(deferred: {resolve: () => void}) {
		await got(url, gotOptions);
		deferred.resolve();
	},
}).add('got - stream', {
	defer: true,
	async fn(deferred: {resolve: () => void}) {
		got.stream(url, gotOptions).resume().once('end', () => {
			deferred.resolve();
		});
	},
}).add('got - core', {
	defer: true,
	async fn(deferred: {resolve: () => void}) {
		const stream = new Request(url, gotOptions);
		void stream.flush();
		stream.resume().once('end', () => {
			deferred.resolve();
		});
	},
}).add('got - core - normalized options', {
	defer: true,
	async fn(deferred: {resolve: () => void}) {
		const stream = new Request(undefined, undefined, normalizedGotOptions);
		void stream.flush();
		stream.resume().once('end', () => {
			deferred.resolve();
		});
	},
}).add('request - callback', {
	defer: true,
	fn(deferred: {resolve: () => void}) {
		request(urlString, requestOptions, (error: Error) => {
			if (error) {
				throw error;
			}

			deferred.resolve();
		});
	},
}).add('request - stream', {
	defer: true,
	fn(deferred: {resolve: () => void}) {
		const stream = request(urlString, requestOptions);
		stream.resume();
		stream.once('end', () => {
			deferred.resolve();
		});
	},
}).add('node-fetch - promise', {
	defer: true,
	async fn(deferred: {resolve: () => void}) {
		const response = await fetch(urlString, fetchOptions);
		await response.text();

		deferred.resolve();
	},
}).add('node-fetch - stream', {
	defer: true,
	async fn(deferred: {resolve: () => void}) {
		const {body} = await fetch(urlString, fetchOptions);

		body!.resume();
		body!.once('end', () => {
			deferred.resolve();
		});
	},
}).add('axios - promise', {
	defer: true,
	async fn(deferred: {resolve: () => void}) {
		// Disabled until it has correct types.
		// await axios.request(axiosOptions);
		deferred.resolve();
	},
}).add('axios - stream', {
	defer: true,
	async fn(deferred: {resolve: () => void}) {
		// Disabled until it has correct types.
		// const result = await axios.request(axiosStreamOptions);
		// const {data}: any = result;

		// data.resume();
		// data.once('end', () => {
		// 	deferred.resolve();
		// });

		deferred.resolve();
	},
}).add('https - stream', {
	defer: true,
	fn(deferred: {resolve: () => void}) {
		https.request(urlString, httpsOptions, response => {
			response.resume();
			response.once('end', () => {
				deferred.resolve();
			});
		}).end();
	},
}).on('cycle', (event: Benchmark.Event) => {
	console.log(String(event.target));
}).on('complete', function (this: any) {
	console.log(`Fastest is ${this.filter('fastest').map('name') as string}`);

	internalBenchmark();
}).run();

const internalBenchmark = (): void => {
	console.log();

	const internalSuite = new Benchmark.Suite();
	internalSuite.add('got - normalize options', {
		fn() {
			// eslint-disable-next-line no-new
			new Options(url, gotOptions);
		},
	}).on('cycle', (event: Benchmark.Event) => {
		console.log(String(event.target));
	});

	internalSuite.run();
};

// Results (i7-7700k, CPU governor: performance):

// H2O server:
// got - promise                   x 2,846 ops/sec ±3.71% (74 runs sampled)
// got - stream                    x 3,840 ops/sec ±1.97% (83 runs sampled)
// got - core                      x 3,929 ops/sec ±2.31% (83 runs sampled)
// got - core - normalized options x 4,483 ops/sec ±2.25% (80 runs sampled)
// request - callback              x 4,784 ops/sec ±4.25% (77 runs sampled)
// request - stream                x 5,138 ops/sec ±2.10% (80 runs sampled)
// node-fetch - promise            x 6,693 ops/sec ±4.56% (77 runs sampled)
// node-fetch - stream             x 7,332 ops/sec ±3.22% (80 runs sampled)
// axios - promise                 x 5,365 ops/sec ±4.30% (74 runs sampled)
// axios - stream                  x 7,424 ops/sec ±3.09% (80 runs sampled)
// https - stream                  x 8,850 ops/sec ±2.77% (71 runs sampled)
// Fastest is https - stream

// got - normalize options         x 73,484 ops/sec ±0.85% (95 runs sampled)
