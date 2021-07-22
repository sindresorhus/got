import {URL} from 'url';
import https from 'https';
import axios from 'axios';
import Benchmark from 'benchmark';
import fetch from 'node-fetch';
import request from 'request';
import got from '../source/index.js';
import Request from '../source/core/index.js';
import Options, {OptionsInit} from '../source/core/options.js';

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
	strictSSL: false,
	agent: httpsAgent,
};

const fetchOptions = {
	agent: httpsAgent,
};

const axiosOptions = {
	url: urlString,
	httpsAgent,
	https: {
		rejectUnauthorized: false,
	},
};

const axiosStreamOptions: typeof axiosOptions & {responseType: 'stream'} = {
	...axiosOptions,
	responseType: 'stream',
};

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
	fn: async (deferred: {resolve: () => void}) => {
		await got(url, gotOptions);
		deferred.resolve();
	},
}).add('got - stream', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		got.stream(url, gotOptions).resume().once('end', () => {
			deferred.resolve();
		});
	},
}).add('got - core', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		const stream = new Request(url, gotOptions);
		void stream.flush();
		stream.resume().once('end', () => {
			deferred.resolve();
		});
	},
}).add('got - core - normalized options', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		const stream = new Request(undefined, undefined, normalizedGotOptions);
		void stream.flush();
		stream.resume().once('end', () => {
			deferred.resolve();
		});
	},
}).add('request - callback', {
	defer: true,
	fn: (deferred: {resolve: () => void}) => {
		request(urlString, requestOptions, (error: Error) => {
			if (error) {
				throw error;
			}

			deferred.resolve();
		});
	},
}).add('request - stream', {
	defer: true,
	fn: (deferred: {resolve: () => void}) => {
		const stream = request(urlString, requestOptions);
		stream.resume();
		stream.once('end', () => {
			deferred.resolve();
		});
	},
}).add('node-fetch - promise', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		const response = await fetch(url, fetchOptions);
		await response.text();

		deferred.resolve();
	},
}).add('node-fetch - stream', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		const {body} = await fetch(url, fetchOptions);

		body.resume();
		body.once('end', () => {
			deferred.resolve();
		});
	},
}).add('axios - promise', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		await axios.request(axiosOptions);
		deferred.resolve();
	},
}).add('axios - stream', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		const {data} = await axios.request(axiosStreamOptions);
		data.resume();
		data.once('end', () => {
			deferred.resolve();
		});
	},
}).add('https - stream', {
	defer: true,
	fn: (deferred: {resolve: () => void}) => {
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
		fn: () => {
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
// got - promise                   x 2,612 ops/sec ±5.44% (71 runs sampled)
// got - stream                    x 3,532 ops/sec ±3.16% (75 runs sampled)
// got - core                      x 3,813 ops/sec ±2.01% (81 runs sampled)
// got - core - normalized options x 4,183 ops/sec ±2.64% (80 runs sampled)
// request - callback              x 4,664 ops/sec ±5.85% (69 runs sampled)
// request - stream                x 4,832 ops/sec ±4.36% (75 runs sampled)
// node-fetch - promise            x 6,490 ops/sec ±5.13% (75 runs sampled)
// node-fetch - stream             x 7,322 ops/sec ±3.33% (77 runs sampled)
// axios - promise                 x 5,213 ops/sec ±5.47% (69 runs sampled)
// axios - stream                  x 7,496 ops/sec ±2.67% (83 runs sampled)
// https - stream                  x 7,766 ops/sec ±5.68% (66 runs sampled)
// Fastest is https - stream
//
// got - normalize options x 73,790 ops/sec ±1.45% (92 runs sampled)

// Node.js server:
// got - promise                   x 2,361 ops/sec ±6.79% (68 runs sampled)
// got - stream                    x 3,275 ops/sec ±3.70% (73 runs sampled)
// got - core                      x 3,364 ops/sec ±3.44% (77 runs sampled)
// got - core - normalized options x 3,868 ops/sec ±3.28% (78 runs sampled)
// request - callback              x 4,277 ops/sec ±5.75% (66 runs sampled)
// request - stream                x 4,526 ops/sec ±5.54% (71 runs sampled)
// node-fetch - promise            x 6,592 ops/sec ±6.02% (74 runs sampled)
// node-fetch - stream             x 7,359 ops/sec ±4.03% (81 runs sampled)
// axios - promise                 x 5,319 ops/sec ±4.72% (75 runs sampled)
// axios - stream                  x 6,842 ops/sec ±3.35% (75 runs sampled)
// https - stream                  x 9,908 ops/sec ±5.25% (76 runs sampled)
// Fastest is https - stream
//
// got - normalize options x 72,035 ops/sec ±0.89% (95 runs sampled)
