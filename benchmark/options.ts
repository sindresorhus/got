import {URL} from 'url';
import https from 'https';
import Benchmark from 'benchmark';
import Options, {OptionsInit} from '../source/core/options.js';

// Configuration
const httpsAgent = new https.Agent({
	keepAlive: true,
	rejectUnauthorized: false,
});

const url = new URL('https://127.0.0.1:8081');

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

const suite = new Benchmark.Suite();

suite.add('got - normalize options', {
	fn: () => {
		// eslint-disable-next-line no-new
		new Options(url, gotOptions);
	},
}).on('cycle', (event: Benchmark.Event) => {
	console.log(String(event.target));
});

suite.run();
