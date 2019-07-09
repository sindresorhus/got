import {PassThrough} from 'stream';

export default (got): PassThrough => {
	const slowStream = new PassThrough();

	for(let i=0;i<11;i++){
			slowStream.push('data\n'.repeat(100));
			got.tickTimers(100);
	}
	
	setTimeout(() => slowStream.push(null), 0);

	// let count = 0;
	// function next() {
	// 	if (count++ < 10) {
	// 		slowStream.push('data\n'.repeat(100));
	// 		got.tickTimers(100);
	// 		setImmediate(next);
	// 	} else {
	// 		// wait before ending the stream since the timeout
	// 		// handler will actually schedule a timeout instead of
	// 		// synchronously running it
	// 		setTimeout(() => slowStream.push(null), 2);
	// 	}
	// }
	// setImmediate(next);
	return slowStream;
};
