import {URL} from 'url';
import https from 'https';
import axios from 'axios';
import Benchmark from 'benchmark';
import fetch from 'node-fetch';
import request from 'request';
import got from '../source/index.js';
import Request from '../source/core/index';
import Options, {OptionsInit} from '../source/core/options';

// Configuration
const httpsAgent = new https.Agent({
	keepAlive: true,
	rejectUnauthorized: false
});

const url = new URL('https://127.0.0.1:8081');
const urlString = url.toString();

const gotOptions: OptionsInit & {isStream?: true} = {
	agent: {
		https: httpsAgent
	},
	httpsOptions: {
		rejectUnauthorized: false
	},
	retry: {
		limit: 0
	}
};

const normalizedGotOptions = new Options(url, gotOptions);

const requestOptions = {
	strictSSL: false,
	agent: httpsAgent
};

const fetchOptions = {
	agent: httpsAgent
};

const axiosOptions = {
	url: urlString,
	httpsAgent,
	https: {
		rejectUnauthorized: false
	}
};

const axiosStreamOptions: typeof axiosOptions & {responseType: 'stream'} = {
	...axiosOptions,
	responseType: 'stream'
};

const httpsOptions = {
	https: {
		rejectUnauthorized: false
	},
	agent: httpsAgent
};

const suite = new Benchmark.Suite();

// Benchmarking
suite.add('got - promise', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		await got(url, gotOptions);
		deferred.resolve();
	}
}).add('got - stream', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		got.stream(url, gotOptions).resume().once('end', () => {
			deferred.resolve();
		});
	}
}).add('got - core', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		const stream = new Request(url, gotOptions);
		void stream.flush();
		stream.resume().once('end', () => {
			deferred.resolve();
		});
	}
}).add('got - core - normalized options', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		const stream = new Request(undefined as any, normalizedGotOptions);
		void stream.flush();
		stream.resume().once('end', () => {
			deferred.resolve();
		});
	}
}).add('request - callback', {
	defer: true,
	fn: (deferred: {resolve: () => void}) => {
		request(urlString, requestOptions, (error: Error) => {
			if (error) {
				throw error;
			}

			deferred.resolve();
		});
	}
}).add('request - stream', {
	defer: true,
	fn: (deferred: {resolve: () => void}) => {
		const stream = request(urlString, requestOptions);
		stream.resume();
		stream.once('end', () => {
			deferred.resolve();
		});
	}
}).add('node-fetch - promise', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		const response = await fetch(url, fetchOptions);
		await response.text();

		deferred.resolve();
	}
}).add('node-fetch - stream', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		const {body} = await fetch(url, fetchOptions);

		body.resume();
		body.once('end', () => {
			deferred.resolve();
		});
	}
}).add('axios - promise', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		await axios.request(axiosOptions);
		deferred.resolve();
	}
}).add('axios - stream', {
	defer: true,
	fn: async (deferred: {resolve: () => void}) => {
		const {data} = await axios.request(axiosStreamOptions);
		data.resume();
		data.once('end', () => {
			deferred.resolve();
		});
	}
}).add('https - stream', {
	defer: true,
	fn: (deferred: {resolve: () => void}) => {
		https.request(urlString, httpsOptions, response => {
			response.resume();
			response.once('end', () => {
				deferred.resolve();
			});
		}).end();
	}
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
		}
	}).on('cycle', (event: Benchmark.Event) => {
		console.log(String(event.target));
	});

	internalSuite.run();
};

// Results (i7-7700k, CPU governor: performance):

// e9359d3fa0cb40324f2b84364408b3f9f7ff2cee (Rewrite Got #1051) - unknown Node.js version
// got - promise                          x 3,092 ops/sec ±5.25% (73 runs sampled)
// got - stream                           x 4,313 ops/sec ±5.61% (72 runs sampled)
// got - promise core                     x 6,756 ops/sec ±5.32% (80 runs sampled)
// got - stream core                      x 6,863 ops/sec ±4.68% (76 runs sampled)
// got - stream core - normalized options x 7,960 ops/sec ±3.83% (81 runs sampled)

// b927e2d028ecc023bf7eff2702ffb5c72016a85a (Fix bugs, increase coverage, update benchmark results) - unknown Node.js version
// got - promise                          x 3,204 ops/sec ±5.27% (73 runs sampled)
// got - stream                           x 5,045 ops/sec ±3.85% (77 runs sampled)
// got - promise core                     x 6,499 ops/sec ±3.67% (77 runs sampled)
// got - stream core                      x 7,047 ops/sec ±2.32% (83 runs sampled)
// got - stream core - normalized options x 7,313 ops/sec ±2.79% (85 runs sampled)

// 7e8898e9095e7da52e4ff342606cfd1dc5186f54 (Merge PromisableRequest into Request) - unknown Node.js version
// got - promise                   x 3,003 ops/sec ±6.26% (70 runs sampled)
// got - stream                    x 3,538 ops/sec ±5.86% (67 runs sampled)
// got - core                      x 5,828 ops/sec ±3.11% (79 runs sampled)
// got - core - normalized options x 7,596 ops/sec ±1.60% (85 runs sampled)

// [main] - Node.js v15.10.0
// got - promise                   x 3,201 ops/sec ±5.24% (67 runs sampled)
// got - stream                    x 3,633 ops/sec ±4.06% (74 runs sampled)
// got - core                      x 4,382 ops/sec ±3.26% (77 runs sampled)
// got - core - normalized options x 5,470 ops/sec ±3.70% (78 runs sampled)

// v12 - Node.js v15.10.0
// got - promise                   x 3,492 ops/sec ±5.13% (71 runs sampled)
// got - stream                    x 4,772 ops/sec ±1.52% (84 runs sampled)
// got - core                      x 4,990 ops/sec ±1.14% (83 runs sampled)
// got - core - normalized options x 5,386 ops/sec ±0.52% (87 runs sampled)

// got - normalize options x 117,810 ops/sec ±0.36% (97 runs sampled)

// ================================================================================

// request - callback              x 6,448 ops/sec ±5.76% (67 runs sampled)
// request - stream                x 7,115 ops/sec ±2.85% (83 runs sampled)
// node-fetch - promise            x 6,236 ops/sec ±5.56% (75 runs sampled)
// node-fetch - stream             x 7,225 ops/sec ±2.10% (81 runs sampled)
// axios - promise                 x 5,620 ops/sec ±3.13% (78 runs sampled)
// axios - stream                  x 7,244 ops/sec ±3.31% (80 runs sampled)
// https - stream                  x 8,588 ops/sec ±5.50% (61 runs sampled)
// Fastest is https - stream
