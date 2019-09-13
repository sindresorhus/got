import {PassThrough} from 'stream';
import {Clock} from 'lolex';

export default (clock: Clock): PassThrough => {
	const slowStream = new PassThrough();

	setImmediate(() => {
		for (let i = 0; i < 10; i++) {
			slowStream.push('data\n'.repeat(100));
			clock.tick(100);
		}

		slowStream.push(null);
	});

	return slowStream;
};
