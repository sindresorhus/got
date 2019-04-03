import {PassThrough} from 'stream';

export default (): PassThrough => {
	const slowStream = new PassThrough();
	let count = 0;

	const interval = setInterval(() => {
		if (count++ < 10) {
			slowStream.push('data\n'.repeat(100));
			return;
		}

		clearInterval(interval);
		slowStream.push(null);
	}, 100);

	return slowStream;
};
