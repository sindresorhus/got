import * as Benchmark from 'benchmark';
import Options, { OptionsInit } from '../source/core/options';

const x: OptionsInit = {
	hooks: {
		beforeRequest: [
			() => {}
		]
	}
};

const y = new Options(x);

const internalSuite = new Benchmark.Suite();
internalSuite.add('got - normalize options', {
	fn: () => {
		new Options(y);
	}
}).on('cycle', (event: Benchmark.Event) => {
	console.log(String(event.target));
});

internalSuite.run();
