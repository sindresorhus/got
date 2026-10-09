// Start an HTTPS server at the `url` below, and then run: node --import=tsx/esm --experimental-bench --bench benchmark/index.ts
import https from 'node:https';
import type {IncomingMessage} from 'node:http';
import {once} from 'node:events';
import type {Readable} from 'node:stream';
// @ts-expect-error `@types/node` has no types for `node:bench` yet.
import {bench as untypedBench} from 'node:bench';
/// import axios from 'axios';
import fetch from 'node-fetch';
import request from 'request';
import got from '../source/index.js';
import Request from '../source/core/index.js';
import Options, {type OptionsInit} from '../source/core/options.js';

type BenchContext = {
	start: () => void;
	end: (operations: number) => void;
};

const bench = untypedBench as (name: string, function_: (context: BenchContext) => void | Promise<void>) => void;

// Configuration
const httpsAgent = new https.Agent({
	keepAlive: true,
	rejectUnauthorized: false,
});

const url = new URL('https://127.0.0.1:8081');
const urlString = url.href;

const gotOptions: OptionsInit = {
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

// Every sample sends the requests one after the other. The server at `url` must already be running.
const operations = 100;

// The requests are real I/O, so V8 cannot remove them. This only checks that all of them completed.
let completed = 0;

function benchmark(name: string, run: () => Promise<void>): void {
	bench(name, async (b: BenchContext) => {
		completed = 0;

		b.start();

		for (let index = 0; index < operations; index++) {
			// The requests must not overlap
			// eslint-disable-next-line no-await-in-loop
			await run();
			completed++;
		}

		b.end(operations);

		if (completed !== operations) {
			throw new Error(`Only ${completed} of ${operations} requests completed`);
		}
	});
}

// Resolves when the stream is fully read, and rejects when it fails
async function consume(stream: Readable): Promise<void> {
	const ended = once(stream, 'end');
	stream.resume();
	await ended;
}

// Benchmarking
benchmark('got - promise', async () => {
	await got(url, gotOptions);
});

benchmark('got - stream', async () => {
	await consume(got.stream(url, gotOptions));
});

benchmark('got - core', async () => {
	const stream = new Request(url, gotOptions);
	void stream.flush();
	await consume(stream);
});

benchmark('got - core - normalized options', async () => {
	const stream = new Request(undefined, undefined, normalizedGotOptions);
	void stream.flush();
	await consume(stream);
});

benchmark('request - callback', async () => {
	await new Promise<void>((resolve, reject) => {
		request(urlString, requestOptions, (error: Error) => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
});

benchmark('request - stream', async () => {
	await consume(request(urlString, requestOptions) as unknown as Readable);
});

benchmark('node-fetch - promise', async () => {
	const response = await fetch(urlString, fetchOptions);
	await response.text();
});

benchmark('node-fetch - stream', async () => {
	const {body} = await fetch(urlString, fetchOptions);

	await consume(body as unknown as Readable);
});

// Disabled until it has correct types.
// benchmark('axios - promise', async () => {
// 	await axios.request(axiosOptions);
// });

// benchmark('axios - stream', async () => {
// 	const result = await axios.request(axiosStreamOptions);
// 	const {data}: any = result;

// 	await consume(data);
// });

benchmark('https - stream', async () => {
	const response = await new Promise<IncomingMessage>((resolve, reject) => {
		https.request(urlString, httpsOptions, resolve).on('error', reject).end();
	});

	await consume(response);
});

// This one does not use the server
bench('got - normalize options', (b: BenchContext) => {
	const normalizeOperations = 10_000;
	let options: Options | undefined;

	b.start();

	for (let index = 0; index < normalizeOperations; index++) {
		options = new Options(url, gotOptions);
	}

	b.end(normalizeOperations);

	if (options === undefined) {
		throw new Error('Unexpected missing options');
	}
});

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
