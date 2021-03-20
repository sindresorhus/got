import * as Benchmark from 'benchmark';
import Options from '../source/core/options';

const x = {
	hooks: {
		beforeRequest: [
			() => {}
		]
	}
};

const internalSuite = new Benchmark.Suite();
internalSuite.add('got - normalize options', {
	fn: () => {
		new Options(x);
	}
}).on('cycle', (event: Benchmark.Event) => {
	console.log(String(event.target));
});

internalSuite.run();
