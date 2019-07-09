import {PassThrough} from 'stream';

export default (got): PassThrough => {
	const slowStream = new PassThrough();

	setImmediate(async () => {
		for (let i = 0; i < 11; i++) {
			slowStream.push('data\n'.repeat(100));
			await got.tickTimers(100);
		}

		slowStream.push(null);
	});
	
	return slowStream;
};
